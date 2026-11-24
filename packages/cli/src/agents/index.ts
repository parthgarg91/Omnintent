// The tester agent (docs/ARCHITECTURE.md, agent 3): an open runner.

export { claudeAgent, postMessages, type ClaudeOptions, type AgentModel, type ModelRequest, type ModelResponse, type ModelMessage, type ModelTool, type ResponseBlock, type TextBlock, type ToolUseBlock, type ToolResultBlock, type Effort } from "./claude.js";
export { exampleCases, type AgentCase, type Platform } from "./tester/cases.js";
export { compareArguments, valueMatches, type ArgumentDiff } from "./tester/compare.js";
export { manifestSurface, mcpServerSurface, overlaySurface, platformToolName, fixtureAnswer, readFixtures, type Surface, type SurfaceTool, type Fixtures } from "./tester/surfaces.js";
export { runAgentTest, runAttempt, summarize, systemPrompt, type AgentTestReport, type Attempt, type CaseResult, type Verdict, type RunOptions } from "./tester/run.js";
export { formatAgentReport, markdownAgentReport, describeAttempt } from "./tester/report.js";
export { siriEvaluationFile, siriPlan, siriUtterance } from "./tester/siri.js";
export { androidRunScript, androidChecklist, devicePlans } from "./tester/android.js";
export { importResults, readResults, resultsTemplate, resolveActionName, type ResultsFile, type ImportedResult } from "./tester/import.js";
