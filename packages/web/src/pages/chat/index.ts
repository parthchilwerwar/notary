// Notary Chat (/app/chat). Presentational pieces are exported for reuse (e.g. a landing excerpt):
//   <MessageView view={reduceChatEvents(recordedEvents, { finished: true })} mode="replay" messageKey="x" compact />
export { ChatPage } from "./ChatPage";
export { MessageView, UserMessage, StepMark, type MessageViewProps } from "./MessageView";
export { Markdown } from "./MarkdownView";
export { reduceChatEvents, applyChatEvent, stopTurn, workSummary, buildSuggestions, type TurnView, type ChatMode } from "./model";
