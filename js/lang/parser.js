// ============================================================================
// ArenaScript Parser — Recursive Descent with Pratt Expression Parsing
// ============================================================================

import { TokenType } from "./tokens.js";

// Known action keywords that take arguments directly (no parens)
const ACTION_KEYWORDS = new Set([
  "move_to", "move_toward", "strafe_left", "strafe_right", "stop",
  "attack", "fire_at", "shield", "retreat",
  "burst_fire", "grenade",
  "move_forward", "move_backward", "turn_left", "turn_right",
  "place_mine", "send_signal", "mark_position", "taunt", "overwatch",
  // Resource economy + advanced combat
  "fire_light", "fire_heavy", "zap", "vent_heat",
  "cloak", "self_destruct",
]);

export class ParseError extends Error {
  constructor(message, line, column) {
    super(`Parse error at ${line}:${column}: ${message}`);
    this.line = line;
    this.column = column;
  }
}

export class Parser {
  #tokens;
  #pos = 0;

  constructor(tokens) {
    this.#tokens = tokens;
  }

  parse() {
    const span = this.#currentSpan();
    const robot = this.#parseRobotDecl();
    let meta;
    let squad;
    let constants;
    let state;
    const handlers = [];
    const functions = [];
    let seenMeta = false;
    let seenSquad = false;
    let seenConst = false;
    let seenState = false;

    while (!this.#isAtEnd()) {
      const token = this.#current();
      switch (token.type) {
        case TokenType.Meta:
          if (seenMeta) {
            throw this.#error("Duplicate meta block");
          }
          meta = this.#parseMetaBlock();
          seenMeta = true;
          break;
        case TokenType.Squad:
          if (seenSquad) {
            throw this.#error("Duplicate squad block");
          }
          squad = this.#parseSquadBlock();
          seenSquad = true;
          break;
        case TokenType.Const:
          if (seenConst) {
            throw this.#error("Duplicate const block");
          }
          constants = this.#parseConstBlock();
          seenConst = true;
          break;
        case TokenType.State:
          if (seenState) {
            throw this.#error("Duplicate state block");
          }
          state = this.#parseStateBlock();
          seenState = true;
          break;
        case TokenType.On:
          handlers.push(this.#parseEventHandler());
          break;
        case TokenType.Fn:
          functions.push(this.#parseFunctionDecl());
          break;
        default:
          throw this.#error(`Unexpected token '${token.value}'`);
      }
    }

    return { kind: "Program", robot, meta, squad, constants, state, handlers, functions, span };
  }

  // --- Top-Level Parsers ---

  #parseRobotDecl() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Robot);
    const name = this.#expect(TokenType.String).value;
    this.#expect(TokenType.Version);
    const version = this.#expect(TokenType.String).value;
    return { kind: "RobotDecl", name, version, span };
  }

  #parseMetaBlock() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Meta);
    this.#expect(TokenType.LeftBrace);
    const entries = [];
    while (!this.#check(TokenType.RightBrace)) {
      const key = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Colon);
      const value = this.#expect(TokenType.String).value;
      entries.push({ key, value });
    }
    this.#expect(TokenType.RightBrace);
    return { kind: "MetaBlock", entries, span };
  }

  #parseConstBlock() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Const);
    this.#expect(TokenType.LeftBrace);
    const entries = [];
    while (!this.#check(TokenType.RightBrace)) {
      const entrySpan = this.#currentSpan();
      const name = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Equal);
      const value = this.#parseExpression();
      entries.push({ name, value, span: entrySpan });
    }
    this.#expect(TokenType.RightBrace);
    return { kind: "ConstBlock", entries, span };
  }

  #parseSquadBlock() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Squad);
    this.#expect(TokenType.LeftBrace);
    let size;
    let roles;

    while (!this.#check(TokenType.RightBrace)) {
      const key = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Colon);

      if (key === "size") {
        size = this.#expect(TokenType.Number).value;
      } else if (key === "roles") {
        roles = [];
        roles.push(this.#expect(TokenType.String).value);
        while (this.#check(TokenType.Comma)) {
          this.#advance();
          roles.push(this.#expect(TokenType.String).value);
        }
      } else {
        throw this.#error(`Unknown squad field '${key}'`);
      }
    }

    this.#expect(TokenType.RightBrace);
    return { kind: "SquadBlock", size, roles, span };
  }

  #parseStateBlock() {
    const span = this.#currentSpan();
    this.#expect(TokenType.State);
    this.#expect(TokenType.LeftBrace);
    const entries = [];
    while (!this.#check(TokenType.RightBrace)) {
      const entrySpan = this.#currentSpan();
      const name = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Colon);
      const type = this.#parseTypeAnnotation();
      this.#expect(TokenType.Equal);
      const initialValue = this.#parseExpression();
      entries.push({ name, type, initialValue, span: entrySpan });
    }
    this.#expect(TokenType.RightBrace);
    return { kind: "StateBlock", entries, span };
  }

  #parseEventHandler() {
    const span = this.#currentSpan();
    this.#expect(TokenType.On);
    const event = this.#expect(TokenType.Identifier).value;
    let param;
    if (this.#check(TokenType.LeftParen)) {
      this.#advance();
      param = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.RightParen);
    }
    const body = this.#parseBlock();
    return { kind: "EventHandler", event, param, body, span };
  }

  #parseFunctionDecl() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Fn);
    const name = this.#expect(TokenType.Identifier).value;
    this.#expect(TokenType.LeftParen);
    const params = [];
    while (!this.#check(TokenType.RightParen)) {
      const paramName = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Colon);
      const paramType = this.#parseTypeAnnotation();
      params.push({ name: paramName, type: paramType });
      if (!this.#check(TokenType.RightParen)) {
        this.#expect(TokenType.Comma);
      }
    }
    this.#expect(TokenType.RightParen);
    let returnType;
    if (this.#check(TokenType.Arrow)) {
      this.#advance();
      returnType = this.#parseTypeAnnotation();
    }
    const body = this.#parseBlock();
    return { kind: "FunctionDecl", name, params, returnType, body, span };
  }

  // --- Type Annotations ---

  #parseTypeAnnotation() {
    const span = this.#currentSpan();
    const name = this.#expect(TokenType.Identifier).value;
    let generic;
    if (name === "list" && this.#check(TokenType.Less)) {
      this.#advance();
      generic = this.#expect(TokenType.Identifier).value;
      this.#expect(TokenType.Greater);
    }
    const nullable = this.#check(TokenType.QuestionMark);
    if (nullable) this.#advance();
    return { kind: "TypeAnnotation", name, nullable, generic, span };
  }

  // --- Statements ---

  #parseBlock() {
    this.#expect(TokenType.LeftBrace);
    const stmts = [];
    while (!this.#check(TokenType.RightBrace)) {
      stmts.push(this.#parseStatement());
    }
    this.#expect(TokenType.RightBrace);
    return stmts;
  }

  #parseStatement() {
    const token = this.#current();

    switch (token.type) {
      case TokenType.Let:
        return this.#parseLetStatement();
      case TokenType.Set:
        return this.#parseSetStatement();
      case TokenType.If:
        return this.#parseIfStatement();
      case TokenType.For:
        return this.#parseForStatement();
      case TokenType.While:
        return this.#parseWhileStatement();
      case TokenType.Break:
        return this.#parseBreakStatement();
      case TokenType.Continue:
        return this.#parseContinueStatement();
      case TokenType.Return:
        return this.#parseReturnStatement();
      case TokenType.After:
        return this.#parseAfterStatement();
      case TokenType.Every:
        return this.#parseEveryStatement();
      default:
        // Check if this is an action keyword
        if (token.type === TokenType.Identifier && ACTION_KEYWORDS.has(token.value)) {
          return this.#parseActionStatement();
        }
        return this.#parseExpressionStatement();
    }
  }

  #parseLetStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Let);
    const name = this.#expect(TokenType.Identifier).value;
    this.#expect(TokenType.Equal);
    const value = this.#parseExpression();
    return { kind: "LetStatement", name, value, span };
  }

  #parseSetStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Set);
    const name = this.#expect(TokenType.Identifier).value;
    this.#expect(TokenType.Equal);
    const value = this.#parseExpression();
    return { kind: "SetStatement", name, value, span };
  }

  #parseIfStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.If);
    const condition = this.#parseExpression();
    const thenBranch = this.#parseBlock();
    const elseIfBranches = [];
    let elseBranch;

    while (this.#check(TokenType.Else)) {
      this.#advance();
      if (this.#check(TokenType.If)) {
        this.#advance();
        const elseIfCondition = this.#parseExpression();
        const elseIfBody = this.#parseBlock();
        elseIfBranches.push({ condition: elseIfCondition, body: elseIfBody });
      } else {
        elseBranch = this.#parseBlock();
        break;
      }
    }

    return { kind: "IfStatement", condition, thenBranch, elseIfBranches, elseBranch, span };
  }

  #parseForStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.For);
    const variable = this.#expect(TokenType.Identifier).value;
    this.#expect(TokenType.In);
    const iterable = this.#parseExpression();
    const body = this.#parseBlock();
    return { kind: "ForStatement", variable, iterable, body, span };
  }

  #parseWhileStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.While);
    const condition = this.#parseExpression();
    const body = this.#parseBlock();
    return { kind: "WhileStatement", condition, body, span };
  }

  #parseBreakStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Break);
    return { kind: "BreakStatement", span };
  }

  #parseContinueStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Continue);
    return { kind: "ContinueStatement", span };
  }

  #parseReturnStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Return);
    let value;
    if (!this.#check(TokenType.RightBrace) && !this.#isAtEnd()) {
      // Only parse value if next token looks like an expression start,
      // not a statement-starting keyword
      const next = this.#current();
      if (
        next.type !== TokenType.RightBrace &&
        next.type !== TokenType.On &&
        next.type !== TokenType.Fn &&
        next.type !== TokenType.Let &&
        next.type !== TokenType.Set &&
        next.type !== TokenType.If &&
        next.type !== TokenType.For &&
        next.type !== TokenType.While &&
        next.type !== TokenType.Break &&
        next.type !== TokenType.Continue &&
        next.type !== TokenType.After &&
        next.type !== TokenType.Every &&
        next.type !== TokenType.Return &&
        next.type !== TokenType.EOF &&
        !(next.type === TokenType.Identifier && ACTION_KEYWORDS.has(next.value))
      ) {
        value = this.#parseExpression();
      }
    }
    return { kind: "ReturnStatement", value, span };
  }

  #parseActionStatement() {
    const span = this.#currentSpan();
    const action = this.#advance().value;
    const args = [];

    // Parse arguments until we hit a block end or statement boundary
    while (
      !this.#check(TokenType.RightBrace) &&
      !this.#check(TokenType.EOF) &&
      !this.#check(TokenType.Let) &&
      !this.#check(TokenType.Set) &&
      !this.#check(TokenType.If) &&
      !this.#check(TokenType.For) &&
      !this.#check(TokenType.While) &&
      !this.#check(TokenType.Break) &&
      !this.#check(TokenType.Continue) &&
      !this.#check(TokenType.Return) &&
      !this.#check(TokenType.On) &&
      !this.#check(TokenType.Fn) &&
      !this.#check(TokenType.After) &&
      !this.#check(TokenType.Every) &&
      !(this.#current().type === TokenType.Identifier && ACTION_KEYWORDS.has(this.#current().value))
    ) {
      args.push(this.#parseExpression());
      break; // Most actions take 0 or 1 argument
    }

    return { kind: "ActionStatement", action, args, span };
  }

  #parseAfterStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.After);
    const delay = this.#parseExpression();
    const body = this.#parseBlock();
    return { kind: "AfterStatement", delay, body, span };
  }

  #parseEveryStatement() {
    const span = this.#currentSpan();
    this.#expect(TokenType.Every);
    const interval = this.#parseExpression();
    const body = this.#parseBlock();
    return { kind: "EveryStatement", interval, body, span };
  }

  #parseExpressionStatement() {
    const span = this.#currentSpan();
    const expression = this.#parseExpression();
    return { kind: "ExpressionStatement", expression, span };
  }

  // --- Expressions (Pratt Parsing) ---

  #parseExpression() {
    return this.#parseOr();
  }

  #parseOr() {
    let left = this.#parseAnd();
    while (this.#check(TokenType.Or)) {
      const span = this.#currentSpan();
      this.#advance();
      const right = this.#parseAnd();
      left = { kind: "BinaryExpr", operator: "or", left, right, span };
    }
    return left;
  }

  #parseAnd() {
    let left = this.#parseComparison();
    while (this.#check(TokenType.And)) {
      const span = this.#currentSpan();
      this.#advance();
      const right = this.#parseComparison();
      left = { kind: "BinaryExpr", operator: "and", left, right, span };
    }
    return left;
  }

  #parseComparison() {
    let left = this.#parseAddition();
    const compOps = {
      [TokenType.EqualEqual]: "==",
      [TokenType.BangEqual]: "!=",
      [TokenType.Less]: "<",
      [TokenType.LessEqual]: "<=",
      [TokenType.Greater]: ">",
      [TokenType.GreaterEqual]: ">=",
    };
    while (this.#current().type in compOps) {
      const span = this.#currentSpan();
      const operator = compOps[this.#advance().type];
      const right = this.#parseAddition();
      left = { kind: "ComparisonExpr", operator, left, right, span };
    }
    return left;
  }

  #parseAddition() {
    let left = this.#parseMultiplication();
    while (this.#check(TokenType.Plus) || this.#check(TokenType.Minus)) {
      const span = this.#currentSpan();
      const op = this.#advance().type === TokenType.Plus ? "+" : "-";
      const right = this.#parseMultiplication();
      left = { kind: "BinaryExpr", operator: op, left, right, span };
    }
    return left;
  }

  #parseMultiplication() {
    let left = this.#parseUnary();
    while (this.#check(TokenType.Star) || this.#check(TokenType.Slash) || this.#check(TokenType.Percent)) {
      const span = this.#currentSpan();
      const token = this.#advance();
      const op = token.type === TokenType.Star ? "*" : token.type === TokenType.Slash ? "/" : "%";
      const right = this.#parseUnary();
      left = { kind: "BinaryExpr", operator: op, left, right, span };
    }
    return left;
  }

  #parseUnary() {
    if (this.#check(TokenType.Minus)) {
      const span = this.#currentSpan();
      this.#advance();
      const operand = this.#parseUnary();
      return { kind: "UnaryExpr", operator: "-", operand, span };
    }
    if (this.#check(TokenType.Not)) {
      const span = this.#currentSpan();
      this.#advance();
      const operand = this.#parseUnary();
      return { kind: "UnaryExpr", operator: "not", operand, span };
    }
    return this.#parseCallOrMember();
  }

  #parseCallOrMember() {
    let expr = this.#parsePrimary();

    while (true) {
      if (this.#check(TokenType.LeftParen) && (expr.kind === "Identifier" || expr.kind === "MemberExpr")) {
        const span = expr.span;
        this.#advance();
        const args = [];
        while (!this.#check(TokenType.RightParen)) {
          args.push(this.#parseExpression());
          if (!this.#check(TokenType.RightParen)) {
            this.#expect(TokenType.Comma);
          }
        }
        this.#expect(TokenType.RightParen);
        // For member expressions, flatten to callee string "object.property"
        // For identifiers, use the name directly
        const callee = expr.kind === "Identifier" ? expr.name : expr;
        expr = { kind: "CallExpr", callee, args, span };
      } else if (this.#check(TokenType.Dot)) {
        const span = this.#currentSpan();
        this.#advance();
        const property = this.#expect(TokenType.Identifier).value;
        expr = { kind: "MemberExpr", object: expr, property, span };
      } else if (this.#check(TokenType.LeftBracket)) {
        const span = this.#currentSpan();
        this.#advance();
        const index = this.#parseExpression();
        this.#expect(TokenType.RightBracket);
        expr = { kind: "IndexExpr", object: expr, index, span };
      } else {
        break;
      }
    }

    return expr;
  }

  #parsePrimary() {
    const token = this.#current();

    switch (token.type) {
      case TokenType.Number:
        this.#advance();
        return { kind: "NumberLiteral", value: parseFloat(token.value), span: { line: token.line, column: token.column } };
      case TokenType.String:
        this.#advance();
        return { kind: "StringLiteral", value: token.value, span: { line: token.line, column: token.column } };
      case TokenType.True:
        this.#advance();
        return { kind: "BooleanLiteral", value: true, span: { line: token.line, column: token.column } };
      case TokenType.False:
        this.#advance();
        return { kind: "BooleanLiteral", value: false, span: { line: token.line, column: token.column } };
      case TokenType.Null_KW:
        this.#advance();
        return { kind: "NullLiteral", span: { line: token.line, column: token.column } };
      case TokenType.Identifier:
        this.#advance();
        return { kind: "Identifier", name: token.value, span: { line: token.line, column: token.column } };
      case TokenType.LeftParen: {
        this.#advance();
        const expr = this.#parseExpression();
        this.#expect(TokenType.RightParen);
        return expr;
      }
      default:
        throw this.#error(`Unexpected token '${token.value}'`);
    }
  }

  // --- Helpers ---

  #current() {
    return this.#tokens[this.#pos] ?? { type: TokenType.EOF, value: "", line: 0, column: 0 };
  }

  #currentSpan() {
    const t = this.#current();
    return { line: t.line, column: t.column };
  }

  #advance() {
    const token = this.#current();
    this.#pos++;
    return token;
  }

  #check(type) {
    return this.#current().type === type;
  }

  #expect(type) {
    const token = this.#current();
    if (token.type !== type) {
      throw this.#error(`Expected ${type}, got '${token.value}' (${token.type})`);
    }
    return this.#advance();
  }

  #isAtEnd() {
    return this.#current().type === TokenType.EOF;
  }

  #error(msg) {
    const t = this.#current();
    return new ParseError(msg, t.line, t.column);
  }
}
