import * as vscode from "vscode";
import {
  ConfigurationConstants,
  TestResults,
} from "../../constants";
import * as messages from "./messages";
import { checkPInstalled, searchDirectory } from "../../miscTools";
import * as child_process from "child_process";
import * as path from "path";

export default class TestingEditor {
  static instance: TestingEditor;
  static controller = vscode.tests.createTestController(
    "pTestController",
    "P Tests"
  );

  public static async createAndRegister(
    context: vscode.ExtensionContext
  ): Promise<TestingEditor> {
    context.subscriptions.push(TestingEditor.controller);
    context.subscriptions.push(
      /*
            CHANGE Text Document => Update the parsing of a Test File
            DELETE or CREATE a Text Document => Update parsing of Test File

            */
      vscode.workspace.onDidChangeTextDocument((e) =>
        updateNodeFromDocument(e.document)
      ),
      vscode.workspace.onWillDeleteFiles((e) =>
        e.files.forEach(async (fileUri) => {
          updateNodeFromDocument(
            await vscode.workspace.openTextDocument(fileUri)
          );
        })
      ),
      vscode.workspace.onDidCreateFiles((e) =>
        e.files.forEach(async (fileUri) => {
          updateNodeFromDocument(
            await vscode.workspace.openTextDocument(fileUri)
          );
        })
      )
    );

    //Looks through the entire test folder to discover where is the test file and where the tests are.
    var files = await searchDirectory(path.join("**", "*.p"));
    if (files != null) {
      for (var i = 0; i < files.length; i++) {
        var x = files.at(i);
        if (x !== undefined) {
          updateNodeFromDocument(await vscode.workspace.openTextDocument(x));
        }
      }
    }
    return TestingEditor.instance;
  }


  public static async updateTestCasesList(currProject: string): Promise<void> {
    
    // Delete all the test items in the testing panel
    TestingEditor.controller.items.forEach((item) => TestingEditor.controller.items.delete(item.id));

    if (vscode.workspace.workspaceFolders !== undefined) {
      const folder = vscode.workspace.workspaceFolders[0].uri;
            currProject = currProject.replace(folder.fsPath, "**");
      // Create relative path pattern to the workspace
      var files = await searchDirectory(path.join(currProject, "**", "*.p"));

      // Create test items for selected p project in the testing panel
      if (files != null) {
                for (var i = 0; i < files.length; i++) {
          var x = files.at(i);
          if (x !== undefined) {
            updateNodeFromDocument(await vscode.workspace.openTextDocument(x));
          }
        }
      }
    }
  }
}

function updateFromContents(
  controller: vscode.TestController,
  content: string,
  uri: vscode.Uri,
  item: vscode.TestItem
) {
  //If the document has already been parsed, remove all the current children to re-parse.
  if (item.children.size > 0) {
    item.children.forEach((child) => item.children.delete(child.id));
  }

  parsePTestFile(content, {
    onTest: (name, range, variants) => {
      var uniqueID = range.start.line.toString() + uri;
      const tCase = controller.createTestItem(uniqueID, name, uri);
      tCase.range = range;

      // Parameterized declarations are compiled into one test class per
      // assignment. Expose those generated names as children so they are
      // visible in the Test Explorer as well.
      variants?.forEach((variantName, index) => {
        const variant = controller.createTestItem(
          `${uniqueID}::${index}`,
          variantName,
          uri
        );
        variant.range = range;
        tCase.children.add(variant);
      });

      item.children.add(tCase);
    },
  });  

  if (item.children.size == 0) {
    controller.items.delete(item.id);
  } else {
    const runProfile = controller.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      (request, token) => {
        runHandler(request, token);
      }
    );
  }
}

// Parses a P test file, looking for test declarations.
//
// The test name is not always the first identifier after `test`: parameterized
// declarations start with `param (...)`, may include an `assume (...)`
// expression and a `(n wise)`/`pairwise` modifier, and can span several lines.
// Every P test declaration ends with `[main = <machine>]`, so the name is the
// identifier immediately before that bracket. Comments and string literals are
// masked out first so their contents cannot be mistaken for declarations.
export function parsePTestFile(
  text: string,
  events: {
    onTest(name: string, range: vscode.Range, variants?: string[]): void;
  }
) {
  const maskedText = maskNonCode(text);
  const testStartRe = /^[ \t]*test\b/gm;
  const declarationStarts: number[] = [];
  let startMatch: RegExpExecArray | null;

  while ((startMatch = testStartRe.exec(maskedText)) !== null) {
    declarationStarts.push(startMatch.index);
  }

  for (let i = 0; i < declarationStarts.length; i++) {
    const declarationStart = declarationStarts[i];
    const declarationEnd =
      i + 1 < declarationStarts.length
        ? declarationStarts[i + 1]
        : maskedText.length;
    const declaration = maskedText.slice(declarationStart, declarationEnd);

    // `[main = ...]` follows the declared test name. Matching the name from
    // that anchor avoids having to understand the param/assume expressions.
    const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n\f]*\[[ \t\r\n\f]*main[ \t\r\n\f]*=/.exec(
      declaration
    );
    if (nameMatch === null) {
      continue;
    }

    const name = nameMatch[1];
    const nameStart = declarationStart + nameMatch.index;
    const startPos = positionAt(text, declarationStart);
    const endLineOffset = lineEndOffset(text, nameStart + name.length);
    const endPos = positionAt(text, endLineOffset);
    const variants = expandParameterizedTest(declaration, nameMatch.index, name);

    events.onTest(name, new vscode.Range(startPos, endPos), variants);
  }
}

type ParamValue = number | boolean;

interface TestParameter {
  name: string;
  values: ParamValue[];
}

// Expands a parameterized test into the same names the P compiler generates for
// its individual variants (e.g. `tcTest___nClients_2___g1_1`). Returns undefined
// for ordinary tests or declarations we cannot expand safely.
function expandParameterizedTest(
  declaration: string,
  nameStart: number,
  name: string
): string[] | undefined {
  const parameters = parseTestParameters(declaration, nameStart);
  if (parameters === undefined || parameters.parameters.length === 0) {
    return undefined;
  }

  const assignments = enumerateAssignments(parameters.parameters).filter(
    (values) => {
      if (parameters.assume === undefined) {
        return true;
      }
      const environment: Record<string, ParamValue> = {};
      parameters.parameters.forEach((parameter, i) => {
        environment[parameter.name] = values[i];
      });
      try {
        return evaluateAssume(parameters.assume, environment);
      } catch {
        return false;
      }
    }
  );

  // The compiler's default is the full Cartesian product. For an explicitly
  // reduced n-wise test the greedy coverage selection is not reproduced here,
  // so do not invent a potentially incomplete variant list.
  const twise = parameters.twise ?? parameters.parameters.length;
  if (twise < parameters.parameters.length) {
    return undefined;
  }

  return assignments.map((values) => {
    const suffix = parameters.parameters
      .map((parameter, i) => `${parameter.name}_${mangleParamValue(values[i])}`)
      .join("__");
    return `${name}___${suffix}`;
  });
}

interface TestParameterInfo {
  parameters: TestParameter[];
  assume?: string;
  twise?: number;
}

function parseTestParameters(
  declaration: string,
  nameStart: number
): TestParameterInfo | undefined {
  const testKeyword = /^[ \t]*test\b/.exec(declaration);
  if (testKeyword === null) {
    return undefined;
  }

  let cursor = skipWhitespace(declaration, testKeyword[0].length);
  let paramText: string | undefined;

  if (isWordAt(declaration, cursor, "param")) {
    cursor = skipWhitespace(declaration, cursor + "param".length);
    if (declaration[cursor] !== "(") {
      return undefined;
    }
    const close = matchingParen(declaration, cursor);
    if (close === -1) {
      return undefined;
    }
    paramText = declaration.slice(cursor + 1, close);
    cursor = close + 1;
  }

  if (paramText === undefined) {
    return undefined;
  }

  let beforeName = declaration.slice(cursor, nameStart);
  let twise: number | undefined;
  const twiseMatch = /(?:[ \t\r\n\f]+pairwise|[ \t\r\n\f]*\([ \t\r\n\f]*(\d+)[ \t\r\n\f]*wise[ \t\r\n\f]*\))[ \t\r\n\f]*$/.exec(
    beforeName
  );
  if (twiseMatch !== null) {
    twise =
      twiseMatch[1] === undefined ? 2 : Number.parseInt(twiseMatch[1], 10);
    beforeName = beforeName.slice(0, twiseMatch.index);
  }

  let assume: string | undefined;
  const assumeKeyword = /^[ \t\r\n\f]*assume\b/.exec(beforeName);
  if (assumeKeyword !== null) {
    assume = beforeName.slice(assumeKeyword[0].length).trim();
  }

  const parameters: TestParameter[] = [];
  const parameterRe = /([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n\f]+in[ \t\r\n\f]*\[([^\]]*)\]/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(paramText)) !== null) {
    if (!/^[,\s]*$/.test(paramText.slice(lastEnd, match.index))) {
      return undefined;
    }
    const values = parseParamValues(match[2]);
    if (values === undefined) {
      return undefined;
    }
    parameters.push({ name: match[1], values });
    lastEnd = parameterRe.lastIndex;
  }

  if (
    parameters.length === 0 ||
    !/^[,\s]*$/.test(paramText.slice(lastEnd))
  ) {
    return undefined;
  }

  return { parameters, assume, twise };
}

function parseParamValues(text: string): ParamValue[] | undefined {
  const values: ParamValue[] = [];
  for (const rawValue of text.split(",")) {
    const value = rawValue.trim().replace(/\s+/g, "");
    if (value === "true" || value === "false") {
      values.push(value === "true");
    } else if (/^-?\d+$/.test(value)) {
      values.push(Number.parseInt(value, 10));
    } else {
      return undefined;
    }
  }
  return values;
}

function enumerateAssignments(parameters: TestParameter[]): ParamValue[][] {
  if (parameters.some((parameter) => parameter.values.length === 0)) {
    return [];
  }

  const indices = parameters.map(() => 0);
  const assignments: ParamValue[][] = [];
  let hasMore = true;

  while (hasMore) {
    assignments.push(
      parameters.map((parameter, i) => parameter.values[indices[i]])
    );

    let advanced = false;
    for (let i = 0; i < indices.length; i++) {
      indices[i]++;
      if (indices[i] < parameters[i].values.length) {
        advanced = true;
        break;
      }
      indices[i] = 0;
    }
    hasMore = advanced;
  }

  return assignments;
}

function mangleParamValue(value: ParamValue): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return value < 0 ? `neg${Math.abs(value)}` : value.toString();
}

function skipWhitespace(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && /[ \t\r\n\f]/.test(text[i])) {
    i++;
  }
  return i;
}

function isWordAt(text: string, offset: number, word: string): boolean {
  return (
    text.slice(offset, offset + word.length) === word &&
    !/[A-Za-z0-9_]/.test(text[offset + word.length] ?? "")
  );
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Evaluates the literal/boolean expressions accepted by `assume` in a test
// declaration. Only the operators supported by P's simple constraint
// evaluator are implemented; anything else aborts expansion.
function evaluateAssume(
  expression: string,
  environment: Record<string, ParamValue>
): boolean {
  const parser = new AssumeParser(expression, environment);
  const value = parser.parse();
  if (typeof value !== "boolean") {
    throw new Error("assume expression is not boolean");
  }
  return value;
}

class AssumeParser {
  private offset = 0;

  public constructor(
    private readonly text: string,
    private readonly environment: Record<string, ParamValue>
  ) {}

  public parse(): ParamValue {
    const value = this.parseOr();
    this.skipWhitespace();
    if (this.offset !== this.text.length) {
      throw new Error("unexpected token in assume expression");
    }
    return value;
  }

  private parseOr(): ParamValue {
    let left = this.parseAnd();
    while (this.consume("||")) {
      left = this.apply("||", left, this.parseAnd());
    }
    return left;
  }

  private parseAnd(): ParamValue {
    let left = this.parseEquality();
    while (this.consume("&&")) {
      left = this.apply("&&", left, this.parseEquality());
    }
    return left;
  }

  private parseEquality(): ParamValue {
    let left = this.parseRelational();
    for (let op = this.consume("==", "!="); op !== undefined; op = this.consume("==", "!=")) {
      left = this.apply(op, left, this.parseRelational());
    }
    return left;
  }

  private parseRelational(): ParamValue {
    let left = this.parseAdditive();
    for (
      let op = this.consume("<=", ">=", "<", ">");
      op !== undefined;
      op = this.consume("<=", ">=", "<", ">")
    ) {
      left = this.apply(op, left, this.parseAdditive());
    }
    return left;
  }

  private parseAdditive(): ParamValue {
    let left = this.parseMultiplicative();
    for (
      let op = this.consume("+", "-");
      op !== undefined;
      op = this.consume("+", "-")
    ) {
      left = this.apply(op, left, this.parseMultiplicative());
    }
    return left;
  }

  private parseMultiplicative(): ParamValue {
    let left = this.parseUnary();
    for (
      let op = this.consume("*", "/", "%");
      op !== undefined;
      op = this.consume("*", "/", "%")
    ) {
      left = this.apply(op, left, this.parseUnary());
    }
    return left;
  }

  private parseUnary(): ParamValue {
    if (this.consume("!")) {
      return !this.asBoolean(this.parseUnary());
    }
    if (this.consume("-")) {
      return -this.asNumber(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ParamValue {
    this.skipWhitespace();
    if (this.consume("(")) {
      const value = this.parseOr();
      if (!this.consume(")")) {
        throw new Error("missing closing parenthesis in assume expression");
      }
      return value;
    }

    this.skipWhitespace();
    const numberMatch = /^\d+/.exec(this.text.slice(this.offset));
    if (numberMatch !== null) {
      this.offset += numberMatch[0].length;
      return Number.parseInt(numberMatch[0], 10);
    }

    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
      this.text.slice(this.offset)
    );
    if (identifierMatch !== null) {
      this.offset += identifierMatch[0].length;
      if (identifierMatch[0] === "true" || identifierMatch[0] === "false") {
        return identifierMatch[0] === "true";
      }
      if (!(identifierMatch[0] in this.environment)) {
        throw new Error("unknown identifier in assume expression");
      }
      return this.environment[identifierMatch[0]];
    }

    throw new Error("unexpected token in assume expression");
  }

  private consume(...operators: string[]): string | undefined {
    this.skipWhitespace();
    for (const op of operators) {
      if (this.text.startsWith(op, this.offset)) {
        this.offset += op.length;
        return op;
      }
    }
    return undefined;
  }

  private skipWhitespace(): void {
    this.offset = skipWhitespace(this.text, this.offset);
  }

  private apply(op: string, left: ParamValue, right?: ParamValue): ParamValue {
    switch (op) {
      case "||":
        return this.asBoolean(left) || this.asBoolean(right);
      case "&&":
        return this.asBoolean(left) && this.asBoolean(right);
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return this.asNumber(left) < this.asNumber(right);
      case "<=":
        return this.asNumber(left) <= this.asNumber(right);
      case ">":
        return this.asNumber(left) > this.asNumber(right);
      case ">=":
        return this.asNumber(left) >= this.asNumber(right);
      case "+":
        return this.asNumber(left) + this.asNumber(right);
      case "-":
        return this.asNumber(left) - this.asNumber(right);
      case "*":
        return this.asNumber(left) * this.asNumber(right);
      case "/":
        return this.asNumber(left) / this.asNumber(right);
      case "%":
        return this.asNumber(left) % this.asNumber(right);
      default:
        throw new Error(`unsupported operator '${op}' in assume expression`);
    }
  }

  private asNumber(value: ParamValue | undefined): number {
    if (typeof value !== "number") {
      throw new Error("expected a number in assume expression");
    }
    return value;
  }

  private asBoolean(value: ParamValue | undefined): boolean {
    if (typeof value !== "boolean") {
      throw new Error("expected a boolean in assume expression");
    }
    return value;
  }
}

// Replaces comments and string literal contents with whitespace while keeping
// the text length and newlines intact, so offsets still map back to `text`.
function maskNonCode(text: string): string {
  const characters = text.split("");

  const mask = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (characters[i] !== "\n" && characters[i] !== "\r") {
        characters[i] = " ";
      }
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      const lineEnd = lineEndOffset(text, i);
      mask(i, lineEnd);
      i = lineEnd;
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "*") {
      const commentEnd = text.indexOf("*/", i + 2);
      const end = commentEnd === -1 ? text.length : commentEnd + 2;
      mask(i, end);
      i = end;
      continue;
    }

    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      mask(i, j);
      i = j;
      continue;
    }

    i++;
  }

  return characters.join("");
}

function positionAt(text: string, offset: number): vscode.Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return new vscode.Position(line, offset - lineStart);
}

function lineEndOffset(text: string, offset: number): number {
  const nextNewline = text.indexOf("\n", offset);
  return nextNewline === -1 ? text.length : nextNewline;
}

//Handles running a Test Run Request
async function runHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
) {
  const run = TestingEditor.controller.createTestRun(request);
  const queue: vscode.TestItem[] = [];

  // Add all the test cases to the queue
  if (request.include) {
    request.include.forEach((test) => {
      if (test.parent == undefined) {
        test.children.forEach(test => {
          queue.push(test);
          run.enqueued(test);
        });
      } else {
        queue.push(test);
        run.enqueued(test);
      }
    });
  } else {
    // A run request without an include list means "run everything".
    TestingEditor.controller.items.forEach((testFile) => {
      if (testFile.parent == undefined) {
        testFile.children.forEach((test) => {
          queue.push(test);
          run.enqueued(test);
        });
      }
    });
  }

  // Create output channel to print the test case run live log
  let tcOutput = vscode.window.createOutputChannel("Test Case Output");
  tcOutput.show();

  runPTestcaseIfQueueNotEmpty(run, queue, tcOutput, token);
}

// Run a p testcase if there are test cases to run, else end the run if there are no test case items or user requested a cancellation
function runPTestcaseIfQueueNotEmpty(run: vscode.TestRun, queue: vscode.TestItem[], tcOutput: vscode.OutputChannel, token: vscode.CancellationToken) {
  if(queue.length > 0) {
    const test = queue.pop()!;
    if(!token.isCancellationRequested) {
      runPTestCase(run, test, tcOutput, queue, token);
    } else {
      cancelTestcaseRun(run, test, false, queue, tcOutput);
    }
  } else {
    run.end(); 
  }
}

//Always runs a SINGLE P Test Case.
function runPTestCase(run: vscode.TestRun, tc: vscode.TestItem, tcOutput: vscode.OutputChannel, queue: vscode.TestItem[], token: vscode.CancellationToken) {
  run.started(tc);
  //Sends P Check command through the terminal
  var projectDirectory = tc.uri?.fsPath !== undefined ? path.parse(path.parse(tc.uri?.fsPath).dir).dir : "";

  if (vscode.workspace.workspaceFolders !== undefined) {
    runCheckCommand(
      run,
      tc,
      tcOutput,
      projectDirectory ?? "",
      queue,
      token
    );
  }
  return;
}

//Check the output of the test.
function checkResult(
  run: vscode.TestRun,
  tc: vscode.TestItem,
  contents: string
) {
  var result = TestResults.Error;
  if (contents.includes("Found 0 bugs")) {
    result = TestResults.Pass;
  } else if (contents.includes("found a bug")) {
    result = TestResults.Fail;
  }
  switch (result) {
    case TestResults.Pass: {
      run.passed(tc);
      break;
    }
    case TestResults.Fail: {
      var msg = new vscode.TestMessage("Failure after P Check Command");
      msg.location = new vscode.Location(tc.uri!, tc.range!);
      run.failed(tc, msg);
      break;
    }
    case TestResults.Error: {
      var msg = new vscode.TestMessage("Test Errored in Running");
      run.errored(tc, msg);
    }
  }
}

//Runs p check in a child process and returns the stdout or result.
async function runCheckCommand(
  run: vscode.TestRun,
  tc: vscode.TestItem,
  tcOutput: vscode.OutputChannel,
  projectDirectory: string,
  queue: vscode.TestItem[],
  token: vscode.CancellationToken
) {
  const config = vscode.workspace.getConfiguration(
    ConfigurationConstants.SectionName
  );
  const numSchedules: number =
    config.get<number>(ConfigurationConstants.Test.Schedules) ?? 1000;
  let additionalArgs: string =
    config.get<string>(ConfigurationConstants.Test.AdditionalArgs) ?? "";

  const p_installed = await checkPInstalled();
  if (!p_installed) {
    tcOutput.appendLine(messages.Messages.Installation.noP);
    run.end();
    return;
  }

  // Build argv form so we never go through a shell. Avoids quoting / injection
  // issues when a test case name contains spaces or shell metacharacters.
  const args: string[] = ["check", "-tc", tc.label];

  if (additionalArgs.trim().length > 0) {
    // Remove any -tc / --test-case the user passed in additionalArgs.
    additionalArgs = additionalArgs.replace(/(^|\s)(-tc|--test-case)\s+\S+/g, "");
    // Tokenise respecting single/double-quoted groups so that flag values
    // containing spaces (e.g. `--out "my dir"`) survive intact.
    args.push(...tokeniseShellArgs(additionalArgs));
  }

  // If the user did not specify -s/--schedules in additionalArgs, fall back
  // to the configured value.
  if (!/(^|\s)(-s|--schedules)\s+\S+/.test(additionalArgs)) {
    args.push("-s", String(numSchedules));
  }

  const printableCommand = ["p", ...args].join(" ");
  tcOutput.appendLine("\n\nExecuting command : " + printableCommand + "\n");

  try {
    const testCaseProcess = child_process.spawn("p", args, {
      cwd: projectDirectory,
      shell: false,
    });

    const testCaseProcessLog: string[] = [];

    testCaseProcess.stdout.on('data', (chunk) => {
      // Collect the log lines and print in the output channel
      var line = chunk.toString().trim();
      line && tcOutput.appendLine(line);
      testCaseProcessLog.push(line);

      // If user requested to cancel the run in the middle of execution, cancel the testcase run and kill the command process
      if(token.isCancellationRequested) {
        testCaseProcess.kill();
        cancelTestcaseRun(run, tc, true, queue, tcOutput);
      }
    });

    testCaseProcess.stderr.on('data', (chunk) => {
      // Collect the log lines and print in the output channel
      var line = chunk.toString().trim();
      line && tcOutput.appendLine(line);
      testCaseProcessLog.push(line);

      // If user requested to cancel the run in the middle of execution, cancel the testcase run and kill the command process
      if(token.isCancellationRequested) {
        testCaseProcess.kill();
        cancelTestcaseRun(run, tc, true, queue, tcOutput);
      }
    });

    // Once command is done executing, set the test case status and run the next p test case
    testCaseProcess.on('close', (code, signal) => {
      checkResult(run, tc, testCaseProcessLog.join(' '));
      runPTestcaseIfQueueNotEmpty(run, queue, tcOutput, token);
    });
  } catch (e) {
    var msg = new vscode.TestMessage("Test Errored in Running");
    run.errored(tc, msg);
    tcOutput.appendLine("Unexpected Error encountered while executing command: " + printableCommand);
    runPTestcaseIfQueueNotEmpty(run, queue, tcOutput, token);
  }
}

function cancelTestcaseRun(run: vscode.TestRun, test: vscode.TestItem, isTestRunning: boolean, queue: vscode.TestItem[], tcOutput: vscode.OutputChannel) {
  
  tcOutput.appendLine("\n\nCancelled the test case run!");

  var msg = new vscode.TestMessage("Test Case Run Cancelled");
  if(isTestRunning)
    run.errored(test, msg);
  queue.forEach((test) => run.errored(test, msg));
  queue = [];
  run.end();
}

// Splits a string of additional CLI arguments into argv form. Honours single
// and double-quoted groups so that values containing whitespace survive.
// Intentionally minimal — does not support env expansion, escape sequences,
// or backticks. That's deliberate: we never pass these through a shell.
function tokeniseShellArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function updateNodeFromDocument(e: vscode.TextDocument) {

  const filename = path.parse(e.fileName).base;
  if (filename == undefined) {
    return;
  }
  if (e.uri.scheme !== "file") {
    return;
  }
  if (!e.uri.path.endsWith(".p")) {
    return;
  }
  const file = getFile(e.uri);
      updateFromContents(TestingEditor.controller, e.getText(), e.uri, file);
  }

//If the Testing File already exists, return the file. If it doesn't, add it to the TestController and then return the file.
function getFile(uri: vscode.Uri) {
  const existing = TestingEditor.controller.items.get(uri.toString());
  if (existing) {
    return existing;
  }
  const file = TestingEditor.controller.createTestItem(
    uri.toString(),
    uri.path,
    uri
  );
  TestingEditor.controller.items.add(file);
  file.canResolveChildren = true;
  return file;
}
