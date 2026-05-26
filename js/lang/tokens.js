// ============================================================================
// ArenaScript Lexer — Tokenizer
// ============================================================================

export const TokenType = Object.freeze({
  // Literals
  Number: "Number",
  String: "String",

  // Identifiers & Keywords
  Identifier: "Identifier",
  Robot: "Robot",
  Version: "Version",
  Meta: "Meta",
  Squad: "Squad",
  Const: "Const",
  State: "State",
  On: "On",
  Fn: "Fn",
  Let: "Let",
  Set: "Set",
  If: "If",
  Else: "Else",
  For: "For",
  In: "In",
  While: "While",
  Break: "Break",
  Continue: "Continue",
  Return: "Return",
  And: "And",
  Or: "Or",
  Not: "Not",
  Null_KW: "Null_KW",
  True: "True",
  False: "False",
  After: "After",
  Every: "Every",

  // Punctuation
  LeftBrace: "LeftBrace",
  RightBrace: "RightBrace",
  LeftParen: "LeftParen",
  RightParen: "RightParen",
  LeftBracket: "LeftBracket",
  RightBracket: "RightBracket",
  Comma: "Comma",
  Colon: "Colon",
  Dot: "Dot",
  Arrow: "Arrow",
  QuestionMark: "QuestionMark",

  // Operators
  Plus: "Plus",
  Minus: "Minus",
  Star: "Star",
  Slash: "Slash",
  Percent: "Percent",
  Equal: "Equal",
  EqualEqual: "EqualEqual",
  BangEqual: "BangEqual",
  Less: "Less",
  LessEqual: "LessEqual",
  Greater: "Greater",
  GreaterEqual: "GreaterEqual",

  // Special
  EOF: "EOF",
});

const KEYWORDS = {
  robot: TokenType.Robot,
  version: TokenType.Version,
  meta: TokenType.Meta,
  squad: TokenType.Squad,
  const: TokenType.Const,
  state: TokenType.State,
  on: TokenType.On,
  fn: TokenType.Fn,
  let: TokenType.Let,
  set: TokenType.Set,
  if: TokenType.If,
  else: TokenType.Else,
  for: TokenType.For,
  in: TokenType.In,
  while: TokenType.While,
  break: TokenType.Break,
  continue: TokenType.Continue,
  return: TokenType.Return,
  and: TokenType.And,
  or: TokenType.Or,
  not: TokenType.Not,
  null: TokenType.Null_KW,
  true: TokenType.True,
  false: TokenType.False,
  after: TokenType.After,
  every: TokenType.Every,
};

export class LexerError extends Error {
  constructor(message, line, column) {
    super(`Lexer error at ${line}:${column}: ${message}`);
    this.line = line;
    this.column = column;
  }
}

const SINGLE_CHAR_TOKENS = {
  "{": TokenType.LeftBrace,
  "}": TokenType.RightBrace,
  "(": TokenType.LeftParen,
  ")": TokenType.RightParen,
  "[": TokenType.LeftBracket,
  "]": TokenType.RightBracket,
  ",": TokenType.Comma,
  ":": TokenType.Colon,
  ".": TokenType.Dot,
  "?": TokenType.QuestionMark,
  "+": TokenType.Plus,
  "-": TokenType.Minus,
  "*": TokenType.Star,
  "/": TokenType.Slash,
  "%": TokenType.Percent,
  "=": TokenType.Equal,
  "<": TokenType.Less,
  ">": TokenType.Greater,
};

export class Lexer {
  #source;
  #pos = 0;
  #line = 1;
  #column = 1;
  #tokens = [];

  constructor(source) {
    this.#source = source;
  }

  tokenize() {
    while (this.#pos < this.#source.length) {
      this.#skipWhitespaceExceptNewlines();

      if (this.#pos >= this.#source.length) break;

      const ch = this.#source[this.#pos];

      // Newlines
      if (ch === "\n") {
        this.#advance();
        continue;
      }

      // Comments
      if (ch === "/" && this.#peek(1) === "/") {
        this.#readComment();
        continue;
      }

      // Strings
      if (ch === '"') {
        this.#readString();
        continue;
      }

      // Numbers
      if (this.#isDigit(ch)) {
        this.#readNumber();
        continue;
      }

      // Identifiers and keywords
      if (this.#isAlpha(ch) || ch === "_") {
        this.#readIdentifier();
        continue;
      }

      // Two-character operators
      if (ch === "-" && this.#peek(1) === ">") {
        this.#addToken(TokenType.Arrow, "->");
        this.#advance();
        this.#advance();
        continue;
      }
      if (ch === "=" && this.#peek(1) === "=") {
        this.#addToken(TokenType.EqualEqual, "==");
        this.#advance();
        this.#advance();
        continue;
      }
      if (ch === "!" && this.#peek(1) === "=") {
        this.#addToken(TokenType.BangEqual, "!=");
        this.#advance();
        this.#advance();
        continue;
      }
      if (ch === "<" && this.#peek(1) === "=") {
        this.#addToken(TokenType.LessEqual, "<=");
        this.#advance();
        this.#advance();
        continue;
      }
      if (ch === ">" && this.#peek(1) === "=") {
        this.#addToken(TokenType.GreaterEqual, ">=");
        this.#advance();
        this.#advance();
        continue;
      }

      // Single-character tokens
      if (SINGLE_CHAR_TOKENS[ch]) {
        this.#addToken(SINGLE_CHAR_TOKENS[ch], ch);
        this.#advance();
        continue;
      }

      throw new LexerError(`Unexpected character '${ch}'`, this.#line, this.#column);
    }

    this.#addToken(TokenType.EOF, "");
    return this.#tokens;
  }

  #advance() {
    const ch = this.#source[this.#pos];
    this.#pos++;
    if (ch === "\n") {
      this.#line++;
      this.#column = 1;
    } else {
      this.#column++;
    }
    return ch;
  }

  #peek(offset = 0) {
    const idx = this.#pos + offset;
    if (idx >= this.#source.length) return "\0";
    return this.#source[idx];
  }

  #skipWhitespaceExceptNewlines() {
    while (this.#pos < this.#source.length) {
      const ch = this.#source[this.#pos];
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.#advance();
      } else {
        break;
      }
    }
  }

  #readComment() {
    // Skip //
    this.#advance();
    this.#advance();
    let value = "";
    while (this.#pos < this.#source.length && this.#source[this.#pos] !== "\n") {
      value += this.#advance();
    }
    // Comments are discarded — not added to token stream
  }

  #readString() {
    const startLine = this.#line;
    const startCol = this.#column;
    this.#advance(); // skip opening "
    let value = "";
    while (this.#pos < this.#source.length && this.#source[this.#pos] !== '"') {
      if (this.#source[this.#pos] === "\n") {
        throw new LexerError("Unterminated string", startLine, startCol);
      }
      if (this.#source[this.#pos] === "\\" && this.#pos + 1 < this.#source.length) {
        this.#advance(); // skip backslash
        const escaped = this.#advance();
        switch (escaped) {
          case "n": value += "\n"; break;
          case "t": value += "\t"; break;
          case "r": value += "\r"; break;
          case "0": value += "\0"; break;
          case "\\": value += "\\"; break;
          case '"': value += '"'; break;
          case "'": value += "'"; break;
          default:
            // Previously fell through to `value += escaped`, silently turning
            // `"\z"` into `"z"`. Now raise so typos are caught at lex time.
            throw new LexerError(
              `Unknown string escape '\\${escaped}'. Supported: \\n \\t \\r \\0 \\\\ \\" \\'`,
              startLine, startCol,
            );
        }
      } else {
        value += this.#advance();
      }
    }
    if (this.#pos >= this.#source.length) {
      throw new LexerError("Unterminated string", startLine, startCol);
    }
    this.#advance(); // skip closing "
    this.#tokens.push({ type: TokenType.String, value, line: startLine, column: startCol });
  }

  #readNumber() {
    const startLine = this.#line;
    const startCol = this.#column;
    let value = "";

    while (this.#pos < this.#source.length && this.#isDigit(this.#source[this.#pos])) {
      value += this.#advance();
    }

    if (this.#pos < this.#source.length && this.#source[this.#pos] === "." && this.#isDigit(this.#peek(1))) {
      value += this.#advance(); // .
      while (this.#pos < this.#source.length && this.#isDigit(this.#source[this.#pos])) {
        value += this.#advance();
      }
    }

    this.#tokens.push({ type: TokenType.Number, value, line: startLine, column: startCol });
  }

  #readIdentifier() {
    const startLine = this.#line;
    const startCol = this.#column;
    let value = "";

    while (
      this.#pos < this.#source.length &&
      (this.#isAlphaNumeric(this.#source[this.#pos]) || this.#source[this.#pos] === "_")
    ) {
      value += this.#advance();
    }

    const type = KEYWORDS[value] ?? TokenType.Identifier;
    this.#tokens.push({ type, value, line: startLine, column: startCol });
  }

  #addToken(type, value) {
    this.#tokens.push({ type, value, line: this.#line, column: this.#column });
  }

  #isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }

  #isAlpha(ch) {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  #isAlphaNumeric(ch) {
    return this.#isAlpha(ch) || this.#isDigit(ch);
  }
}
