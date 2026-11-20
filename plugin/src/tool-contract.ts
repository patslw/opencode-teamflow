export const TEAMFLOW_TOOL_NAMESPACE = "teamflow";
export const TEAMFLOW_COMMAND = `${TEAMFLOW_TOOL_NAMESPACE}_command`;
export const TEAMFLOW_CONTEXT = `${TEAMFLOW_TOOL_NAMESPACE}_context`;

// Core dispatches the outer Code Mode runner as "execute", and nested plugin
// hooks receive the effective registry ID (not a catalog path with dots).
export const discussionPermissions = [
  "execute", "read", "glob", "grep", "skill", TEAMFLOW_COMMAND, TEAMFLOW_CONTEXT,
] as const;
export const allowsDiscussionTool = (id: string) => discussionPermissions.some(allowed => allowed === id);

export const teamflowToolInstructions =
  'Teamflow tools are in the `teamflow` Code Mode namespace. Use the native `execute` tool with plain JavaScript, e.g. `return await tools.teamflow.context({});`. ' +
  'To ask the actual user, use `return await tools.teamflow.command({type:"question.ask",payload:{question:"<your concrete question>"}});` and end the turn. ' +
  'Use `tools.teamflow.command(...)` for the other structured commands too. In Code Mode use `search({namespace:"teamflow"})` to discover exact paths and schemas. ' +
  'The effective tool IDs shown outside the namespace are `teamflow_command` and `teamflow_context`; prose is not a tool call.';
