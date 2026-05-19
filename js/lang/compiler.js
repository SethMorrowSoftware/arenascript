// ============================================================================
// ArenaScript Compiler — AST → Bytecode
// ============================================================================

import { Op } from "../runtime/opcodes.js";
import { LANGUAGE_VERSION } from "../shared/config.js";

let nextProgramSequence = 0;

export class CompileError extends Error {
  constructor(message, line, column) {
    super(`Compile error at ${line}:${column}: ${message}`);
    this.line = line;
    this.column = column;
  }
}

class ChunkBuilder {
  code = [];
  constants = [];
  locals = [];
  localCount = 0;
  maxLocalCount = 0;
  scopeDepth = 0;
  sourceMap = new Map();

  emit(op, line = 0, column = 0) {
    const offset = this.code.length;
    this.code.push(op);
    if (line > 0) this.sourceMap.set(offset, { line, column });
    return offset;
  }

  emitWithOperand(op, operand, line = 0, column = 0) {
    const offset = this.emit(op, line, column);
    // Encode operand as 2 bytes (big-endian)
    this.code.push((operand >> 8) & 0xff);
    this.code.push(operand & 0xff);
    return offset;
  }

  addConstant(entry) {
    // Dedup constants
    for (let i = 0; i < this.constants.length; i++) {
      const c = this.constants[i];
      if (c.type === entry.type) {
        if (c.type === "null") return i;
        if ("value" in c && "value" in entry && c.value === entry.value) return i;
      }
    }
    if (this.constants.length >= 0xFFFF) {
      throw new Error("Constant pool overflow: program exceeds 65535 constants");
    }
    this.constants.push(entry);
    return this.constants.length - 1;
  }

  /** Emit a placeholder jump, returns the offset to patch later */
  emitJump(op) {
    const offset = this.code.length;
    this.code.push(op, 0, 0);
    return offset;
  }

  /** Patch a previously emitted jump to point to current position */
  patchJump(offset) {
    const target = this.code.length;
    this.code[offset + 1] = (target >> 8) & 0xff;
    this.code[offset + 2] = target & 0xff;
  }

  declareLocal(name) {
    const slot = this.localCount++;
    if (this.localCount > this.maxLocalCount) {
      this.maxLocalCount = this.localCount;
    }
    this.locals.push({ name, slot, depth: this.scopeDepth });
    return slot;
  }

  resolveLocal(name) {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      if (this.locals[i].name === name) return this.locals[i].slot;
    }
    return null;
  }

  beginScope() {
    this.scopeDepth++;
  }

  endScope() {
    while (this.locals.length > 0 && this.locals[this.locals.length - 1].depth === this.scopeDepth) {
      this.locals.pop();
      this.localCount--;
    }
    this.scopeDepth--;
  }

  toChunk() {
    return {
      code: this.code,
      constants: this.constants,
      localCount: this.maxLocalCount,
      sourceMap: this.sourceMap,
    };
  }
}

export class Compiler {
  #stateSlots = [];
  #stateIndexMap = new Map();
  #constMap = new Map();
  #evaluatedConstants = new Map();
  #functionOffsets = new Map();
  #userFunctionNames = new Set();
  #pendingCalls = [];
  // Stack of loop contexts: each holds pending jumps that `break` and
  // `continue` statements emitted while compiling the loop body, which get
  // patched once we know the loop's exit and iteration-step offsets.
  #loopStack = [];

  #reset() {
    this.#stateSlots = [];
    this.#stateIndexMap = new Map();
    this.#constMap = new Map();
    this.#evaluatedConstants = new Map();
    this.#functionOffsets = new Map();
    this.#userFunctionNames = new Set();
    this.#pendingCalls = [];
    this.#loopStack = [];
  }

  compile(program) {
    this.#reset();
    const builder = new ChunkBuilder();

    // Register constants in the constant pool FIRST so that state slot
    // initializers can reference them.
    if (program.constants) {
      for (const entry of program.constants.entries) {
        const val = this.#evaluateConstantExpr(entry.value);
        if (typeof val === "number" && !Number.isFinite(val)) {
          throw new CompileError(
            `Constant '${entry.name}' evaluates to ${Number.isNaN(val) ? "NaN" : "Infinity"}; only finite numbers are allowed`,
            entry.span.line,
            entry.span.column,
          );
        }
        this.#evaluatedConstants.set(entry.name, val);
        let constIdx;
        if (typeof val === "number") {
          constIdx = builder.addConstant({ type: "number", value: val });
        } else if (typeof val === "string") {
          constIdx = builder.addConstant({ type: "string", value: val });
        } else if (typeof val === "boolean") {
          constIdx = builder.addConstant({ type: "boolean", value: val });
        } else {
          constIdx = builder.addConstant({ type: "null" });
        }
        this.#constMap.set(entry.name, constIdx);
      }
    }

    // Register state slots (may reference already-registered constants).
    if (program.state) {
      for (const entry of program.state.entries) {
        const initial = this.#evaluateConstantExpr(entry.initialValue);
        if (typeof initial === "number" && !Number.isFinite(initial)) {
          throw new CompileError(
            `State variable '${entry.name}' initial value is ${Number.isNaN(initial) ? "NaN" : "Infinity"}; only finite numbers are allowed`,
            entry.span.line,
            entry.span.column,
          );
        }
        const idx = this.#stateSlots.length;
        this.#stateSlots.push({
          name: entry.name,
          type: entry.type.name + (entry.type.nullable ? "?" : ""),
          initialValue: initial,
        });
        this.#stateIndexMap.set(entry.name, idx);
      }
    }

    // Pre-register all function names so forward references resolve correctly
    for (const fn of program.functions) {
      this.#userFunctionNames.add(fn.name);
    }

    // Compile all functions, recording their bytecode offsets
    const functions = new Map();
    for (const fn of program.functions) {
      const offset = builder.code.length;
      functions.set(fn.name, offset);
      this.#functionOffsets.set(fn.name, offset);
      this.#compileFunction(fn, builder);
    }

    // Back-patch any forward function references
    for (const pending of this.#pendingCalls) {
      const target = this.#functionOffsets.get(pending.name);
      if (target !== undefined) {
        builder.code[pending.offset + 1] = (target >> 8) & 0xff;
        builder.code[pending.offset + 2] = target & 0xff;
      }
    }

    // Compile event handlers (can now reference any function)
    const eventHandlers = new Map();
    const eventHandlerHasParam = new Set();
    for (const handler of program.handlers) {
      const offset = builder.code.length;
      eventHandlers.set(handler.event, offset);
      if (handler.param) eventHandlerHasParam.add(handler.event);
      this.#compileEventHandler(handler, builder);
      builder.emit(Op.RETURN);
    }

    builder.emit(Op.HALT);

    // Determine robot class from meta
    let robotClass = "ranger";
    if (program.meta) {
      const classEntry = program.meta.entries.find(e => e.key === "class");
      if (classEntry) robotClass = classEntry.value;
    }

    const chunk = builder.toChunk();

    // Guard against bytecode exceeding the 16-bit offset space used by
    // jump/call instructions. Downstream validation (validateParticipant)
    // also enforces this, but we catch it earlier with a clearer error.
    if (chunk.code.length > 65535) {
      throw new Error(
        `Compiled bytecode is ${chunk.code.length} bytes, exceeds maximum of 65535. Split your program into smaller functions.`
      );
    }

    const squadSizeRaw = program.squad?.size !== undefined ? Number(program.squad.size) : 1;
    let squadSize = Number.isInteger(squadSizeRaw) ? squadSizeRaw : 1;
    if (squadSize < 1) squadSize = 1;
    if (squadSize > 5) squadSize = 5;
    const squadRoles = Array.isArray(program.squad?.roles) ? program.squad.roles : [];

    return {
      program: {
        programId: `prog_${++nextProgramSequence}`,
        sourceHash: "",
        languageVersion: LANGUAGE_VERSION,
        robotName: program.robot.name,
        robotClass,
        bytecode: new Uint8Array(chunk.code),
        stateSlots: this.#stateSlots,
        eventHandlers,
        functions,
        localWindowSize: chunk.localCount,
        eventHandlerHasParam,
        sourceMap: chunk.sourceMap,
        squad: {
          size: squadSize,
          roles: squadRoles,
        },
      },
      constants: chunk.constants,
    };
  }

  #compileEventHandler(handler, b) {
    b.beginScope();
    if (handler.param) {
      const slot = b.declareLocal(handler.param);
      // Pop the event parameter (pushed by the VM) into the local slot
      b.emitWithOperand(Op.STORE_LOCAL, slot);
    }
    this.#compileStatements(handler.body, b);
    b.endScope();
  }

  #compileFunction(fn, b) {
    b.beginScope();
    // Declare local slots for parameters
    const paramSlots = [];
    for (const param of fn.params) {
      paramSlots.push(b.declareLocal(param.name));
    }
    // Pop caller-pushed arguments into parameter slots (reverse order since stack is LIFO)
    for (let i = paramSlots.length - 1; i >= 0; i--) {
      b.emitWithOperand(Op.STORE_LOCAL, paramSlots[i]);
    }
    this.#compileStatements(fn.body, b);
    b.emit(Op.RETURN);
    b.endScope();
  }

  #compileStatements(stmts, b) {
    for (const stmt of stmts) {
      this.#compileStatement(stmt, b);
    }
  }

  #compileStatement(stmt, b) {
    switch (stmt.kind) {
      case "LetStatement": {
        this.#compileExpression(stmt.value, b);
        const slot = b.declareLocal(stmt.name);
        b.emitWithOperand(Op.STORE_LOCAL, slot, stmt.span.line, stmt.span.column);
        break;
      }

      case "SetStatement": {
        this.#compileExpression(stmt.value, b);
        // Prefer locals over state when both names exist: locals shadow
        // state inside nested scopes, matching the semantic analyzer's
        // resolution order.
        const localSlot = b.resolveLocal(stmt.name);
        if (localSlot !== null) {
          b.emitWithOperand(Op.STORE_LOCAL, localSlot, stmt.span.line, stmt.span.column);
          break;
        }
        const stateIdx = this.#stateIndexMap.get(stmt.name);
        if (stateIdx === undefined) {
          throw new CompileError(`Unknown variable '${stmt.name}' (not a local or state var)`, stmt.span.line, stmt.span.column);
        }
        b.emitWithOperand(Op.STORE_STATE, stateIdx, stmt.span.line, stmt.span.column);
        break;
      }

      case "IfStatement": {
        this.#compileExpression(stmt.condition, b);
        const jumpToElse = b.emitJump(Op.JMP_IF_FALSE);
        b.beginScope();
        this.#compileStatements(stmt.thenBranch, b);
        b.endScope();

        if (stmt.elseIfBranches.length > 0 || stmt.elseBranch) {
          // Collect all jumps-to-end so we can patch them after the full chain
          const endJumps = [];
          endJumps.push(b.emitJump(Op.JMP));
          b.patchJump(jumpToElse);

          for (let i = 0; i < stmt.elseIfBranches.length; i++) {
            const branch = stmt.elseIfBranches[i];
            this.#compileExpression(branch.condition, b);
            const jumpNext = b.emitJump(Op.JMP_IF_FALSE);
            b.beginScope();
            this.#compileStatements(branch.body, b);
            b.endScope();
            endJumps.push(b.emitJump(Op.JMP));
            b.patchJump(jumpNext);
          }

          if (stmt.elseBranch) {
            b.beginScope();
            this.#compileStatements(stmt.elseBranch, b);
            b.endScope();
          }

          // Patch all end-jumps to point here (after the entire if/else chain)
          for (const jump of endJumps) {
            b.patchJump(jump);
          }
        } else {
          b.patchJump(jumpToElse);
        }
        break;
      }

      case "ForStatement": {
        // Compile iterable, then iterate
        this.#compileExpression(stmt.iterable, b);
        b.emit(Op.ITER_START);
        const loopStart = b.code.length;
        const exitJump = b.emitJump(Op.ITER_NEXT);

        b.beginScope();
        const slot = b.declareLocal(stmt.variable);
        b.emitWithOperand(Op.STORE_LOCAL, slot);
        const ctx = { kind: "for", breaks: [], continues: [] };
        this.#loopStack.push(ctx);
        this.#compileStatements(stmt.body, b);
        this.#loopStack.pop();
        b.endScope();

        // `continue` jumps here — back to ITER_NEXT
        for (const off of ctx.continues) b.patchJump(off);
        // Jump back to loop start
        b.emitWithOperand(Op.JMP, loopStart);
        b.patchJump(exitJump);
        // `break` jumps to the ITER_END (not past it) so the iterator is
        // still popped off the VM's iterator stack. Skipping it would leak
        // the iterator and corrupt any enclosing loop's iteration.
        const iterEndOffset = b.code.length;
        b.emit(Op.ITER_END);
        for (const off of ctx.breaks) {
          b.code[off + 1] = (iterEndOffset >> 8) & 0xff;
          b.code[off + 2] = iterEndOffset & 0xff;
        }
        break;
      }

      case "WhileStatement": {
        // Guard against trivial infinite loops at compile time when the
        // condition is a literal true — push a visible error so authors
        // don't silently hang the tick. We still allow loops that break out.
        const loopTop = b.code.length;
        this.#compileExpression(stmt.condition, b);
        const exitJump = b.emitJump(Op.JMP_IF_FALSE);
        b.beginScope();
        const ctx = { kind: "while", breaks: [], continues: [] };
        this.#loopStack.push(ctx);
        this.#compileStatements(stmt.body, b);
        this.#loopStack.pop();
        b.endScope();
        // `continue` jumps back to the top (re-check condition)
        for (const off of ctx.continues) {
          b.code[off + 1] = (loopTop >> 8) & 0xff;
          b.code[off + 2] = loopTop & 0xff;
        }
        b.emitWithOperand(Op.JMP, loopTop);
        b.patchJump(exitJump);
        // `break` jumps past the loop entirely
        for (const off of ctx.breaks) b.patchJump(off);
        break;
      }

      case "BreakStatement": {
        const ctx = this.#loopStack[this.#loopStack.length - 1];
        if (!ctx) {
          throw new CompileError("'break' outside of a loop", stmt.span.line, stmt.span.column);
        }
        ctx.breaks.push(b.emitJump(Op.JMP));
        break;
      }

      case "ContinueStatement": {
        const ctx = this.#loopStack[this.#loopStack.length - 1];
        if (!ctx) {
          throw new CompileError("'continue' outside of a loop", stmt.span.line, stmt.span.column);
        }
        ctx.continues.push(b.emitJump(Op.JMP));
        break;
      }

      case "ReturnStatement": {
        // Unwind iterator frames for every `for` loop that lexically
        // encloses this return. The VM's RETURN opcodes do not touch the
        // iterator stack, so without explicit ITER_END cleanup an early
        // return from inside a `for` leaks the iterator and corrupts the
        // next loop executed in the same run.
        const enclosingForLoops = this.#loopStack.filter(c => c.kind === "for").length;
        if (stmt.value) {
          this.#compileExpression(stmt.value, b);
          for (let i = 0; i < enclosingForLoops; i++) b.emit(Op.ITER_END);
          b.emit(Op.RETURN_VAL, stmt.span.line, stmt.span.column);
        } else {
          for (let i = 0; i < enclosingForLoops; i++) b.emit(Op.ITER_END);
          b.emit(Op.RETURN, stmt.span.line, stmt.span.column);
        }
        break;
      }

      case "ActionStatement": {
        // Push action name as string constant
        const nameIdx = b.addConstant({ type: "string", value: stmt.action });
        b.emitWithOperand(Op.CONST_STR, nameIdx, stmt.span.line, stmt.span.column);
        // Push arguments
        for (const arg of stmt.args) {
          this.#compileExpression(arg, b);
        }
        // Emit action with arg count
        b.emitWithOperand(Op.ACTION, stmt.args.length);
        break;
      }

      case "AfterStatement": {
        // Compile: push delay, emit SCHEDULE_ONCE <bodyEnd>, compile body, RETURN
        this.#compileExpression(stmt.delay, b);
        // SCHEDULE_ONCE takes a 2-byte operand that will be patched to body-end
        const scheduleOffset = b.code.length;
        b.emit(Op.SCHEDULE_ONCE, stmt.span.line, stmt.span.column);
        b.code.push(0, 0); // placeholder for body-end offset
        // Compile body
        b.beginScope();
        this.#compileStatements(stmt.body, b);
        b.endScope();
        b.emit(Op.RETURN);
        // Patch the jump-past to point here
        const bodyEnd = b.code.length;
        b.code[scheduleOffset + 1] = (bodyEnd >> 8) & 0xff;
        b.code[scheduleOffset + 2] = bodyEnd & 0xff;
        break;
      }

      case "EveryStatement": {
        this.#compileExpression(stmt.interval, b);
        const scheduleOffset = b.code.length;
        b.emit(Op.SCHEDULE_REPEAT, stmt.span.line, stmt.span.column);
        b.code.push(0, 0); // placeholder for body-end offset
        b.beginScope();
        this.#compileStatements(stmt.body, b);
        b.endScope();
        b.emit(Op.RETURN);
        const bodyEnd = b.code.length;
        b.code[scheduleOffset + 1] = (bodyEnd >> 8) & 0xff;
        b.code[scheduleOffset + 2] = bodyEnd & 0xff;
        break;
      }

      case "ExpressionStatement": {
        this.#compileExpression(stmt.expression, b);
        b.emit(Op.POP); // discard result
        break;
      }
    }
  }

  #compileExpression(expr, b) {
    switch (expr.kind) {
      case "NumberLiteral": {
        const idx = b.addConstant({ type: "number", value: expr.value });
        b.emitWithOperand(Op.CONST_NUM, idx, expr.span.line, expr.span.column);
        break;
      }

      case "StringLiteral": {
        const idx = b.addConstant({ type: "string", value: expr.value });
        b.emitWithOperand(Op.CONST_STR, idx, expr.span.line, expr.span.column);
        break;
      }

      case "BooleanLiteral":
        b.emitWithOperand(Op.CONST_BOOL, expr.value ? 1 : 0, expr.span.line, expr.span.column);
        break;

      case "NullLiteral":
        b.emit(Op.CONST_NULL, expr.span.line, expr.span.column);
        break;

      case "Identifier": {
        // Check local first
        const local = b.resolveLocal(expr.name);
        if (local !== null) {
          b.emitWithOperand(Op.LOAD_LOCAL, local, expr.span.line, expr.span.column);
          break;
        }
        // Check state
        const stateIdx = this.#stateIndexMap.get(expr.name);
        if (stateIdx !== undefined) {
          b.emitWithOperand(Op.LOAD_STATE, stateIdx, expr.span.line, expr.span.column);
          break;
        }
        // Check constants
        const constIdx = this.#constMap.get(expr.name);
        if (constIdx !== undefined) {
          b.emitWithOperand(Op.LOAD_CONST, constIdx, expr.span.line, expr.span.column);
          break;
        }
        throw new CompileError(`Unresolved identifier '${expr.name}'`, expr.span.line, expr.span.column);
      }

      case "BinaryExpr": {
        if (expr.operator === "and") {
          // Short-circuit: if left is falsy, skip right entirely
          this.#compileExpression(expr.left, b);
          b.emit(Op.DUP);
          const skipRight = b.emitJump(Op.JMP_IF_FALSE);
          b.emit(Op.POP); // discard truthy left value
          this.#compileExpression(expr.right, b);
          b.patchJump(skipRight);
          break;
        }
        if (expr.operator === "or") {
          // Short-circuit: if left is truthy, skip right entirely
          this.#compileExpression(expr.left, b);
          b.emit(Op.DUP);
          const skipRight = b.emitJump(Op.JMP_IF_TRUE);
          b.emit(Op.POP); // discard falsy left value
          this.#compileExpression(expr.right, b);
          b.patchJump(skipRight);
          break;
        }
        this.#compileExpression(expr.left, b);
        this.#compileExpression(expr.right, b);
        const opMap = {
          "+": Op.ADD, "-": Op.SUB, "*": Op.MUL, "/": Op.DIV, "%": Op.MOD,
        };
        b.emit(opMap[expr.operator], expr.span.line, expr.span.column);
        break;
      }

      case "UnaryExpr": {
        this.#compileExpression(expr.operand, b);
        if (expr.operator === "-") b.emit(Op.NEG, expr.span.line, expr.span.column);
        else b.emit(Op.NOT, expr.span.line, expr.span.column);
        break;
      }

      case "ComparisonExpr": {
        this.#compileExpression(expr.left, b);
        this.#compileExpression(expr.right, b);
        const compMap = {
          "==": Op.EQ, "!=": Op.NEQ, "<": Op.LT, "<=": Op.LTE, ">": Op.GT, ">=": Op.GTE,
        };
        b.emit(compMap[expr.operator], expr.span.line, expr.span.column);
        break;
      }

      case "CallExpr": {
        // Method-call syntax (e.g. `obj.method()`) is not supported — the
        // parser produces a MemberExpr callee that we cannot resolve to a
        // function offset or built-in name. Fail loudly instead of silently
        // generating broken bytecode.
        if (typeof expr.callee !== "string") {
          throw new CompileError(
            `Method call syntax is not supported. Use a free function (e.g. 'fn_name(arg)') instead.`,
            expr.span?.line ?? 0,
            expr.span?.column ?? 0,
          );
        }
        // Push arguments
        for (const arg of expr.args) {
          this.#compileExpression(arg, b);
        }
        // Check if it's a user function (already compiled or forward reference) or built-in
        if (this.#functionOffsets.has(expr.callee)) {
          b.emitWithOperand(Op.CALL, this.#functionOffsets.get(expr.callee), expr.span.line, expr.span.column);
        } else if (this.#userFunctionNames.has(expr.callee)) {
          // Forward reference — emit placeholder CALL, will be back-patched
          const offset = b.emitWithOperand(Op.CALL, 0, expr.span.line, expr.span.column);
          this.#pendingCalls.push({ offset, name: expr.callee });
        } else {
          // Built-in call — encode name as constant
          const nameIdx = b.addConstant({ type: "string", value: expr.callee });
          b.emitWithOperand(Op.CALL_BUILTIN, nameIdx, expr.span.line, expr.span.column);
          // arg count follows
          b.code.push(expr.args.length);
        }
        break;
      }

      case "MemberExpr": {
        this.#compileExpression(expr.object, b);
        const propIdx = b.addConstant({ type: "string", value: expr.property });
        b.emitWithOperand(Op.GET_MEMBER, propIdx, expr.span.line, expr.span.column);
        break;
      }

      case "IndexExpr": {
        this.#compileExpression(expr.object, b);
        this.#compileExpression(expr.index, b);
        b.emit(Op.GET_INDEX, expr.span.line, expr.span.column);
        break;
      }
    }
  }

  #evaluateConstantExpr(expr) {
    switch (expr.kind) {
      case "NumberLiteral": return expr.value;
      case "StringLiteral": return expr.value;
      case "BooleanLiteral": return expr.value;
      case "NullLiteral": return null;
      case "Identifier": {
        // Allow constants to reference previously-defined constants
        const constIdx = this.#constMap.get(expr.name);
        if (constIdx !== undefined) {
          // Temporary: look up from stateSlots which stores evaluated values
          // Actually need to get the value from the already-processed constants
          // #constMap maps name -> constant pool index, so find the entry
          return this.#evaluatedConstants?.get(expr.name) ?? null;
        }
        return null;
      }
      case "UnaryExpr": {
        const operand = this.#evaluateConstantExpr(expr.operand);
        if (expr.operator === "-" && typeof operand === "number") return -operand;
        if (expr.operator === "not") return !operand;
        return null;
      }
      case "BinaryExpr": {
        const left = this.#evaluateConstantExpr(expr.left);
        const right = this.#evaluateConstantExpr(expr.right);
        if (typeof left === "number" && typeof right === "number") {
          switch (expr.operator) {
            case "+": return left + right;
            case "-": return left - right;
            case "*": return left * right;
            case "/": return right !== 0 ? left / right : 0;
            case "%": return right !== 0 ? left % right : 0;
          }
        }
        if (typeof left === "string" && typeof right === "string" && expr.operator === "+") {
          return left + right;
        }
        return null;
      }
      case "ComparisonExpr": {
        const left = this.#evaluateConstantExpr(expr.left);
        const right = this.#evaluateConstantExpr(expr.right);
        if (left === null || right === null) return null;
        switch (expr.operator) {
          case "==": return left === right;
          case "!=": return left !== right;
          case "<": return left < right;
          case "<=": return left <= right;
          case ">": return left > right;
          case ">=": return left >= right;
        }
        return null;
      }
      default: return null;
    }
  }
}
