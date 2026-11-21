export const TEAMFLOW_TOOL_NAMESPACE = "teamflow";
export const TEAMFLOW_COMMAND = `${TEAMFLOW_TOOL_NAMESPACE}_command`;
export const TEAMFLOW_CONTEXT = `${TEAMFLOW_TOOL_NAMESPACE}_context`;

export const teamflowToolInstructions =
  'Teamflow tools are in the `teamflow` Code Mode namespace. Use the native `execute` tool with plain JavaScript, e.g. `return await tools.teamflow.context({});`. ' +
  'For a business decision that blocks work, use `tools.teamflow.command({type:"question.ask",payload:{question:"<your concrete question>",options:["<concrete choice A>","<concrete choice B>"]}})` and end the turn. Provide 2–4 meaningful choices when there are real alternatives; omit options for an open-ended question. The user can always type a different answer. Native `question` is a separate same-session form for quick input, not a tracked business blocker or Gate approval. ' +
  'Use `tools.teamflow.command(...)` for the other structured commands too. In Code Mode use `search({namespace:"teamflow"})` to discover exact paths and schemas. ' +
  'The effective tool IDs shown outside the namespace are `teamflow_command` and `teamflow_context`; prose is not a tool call.';
