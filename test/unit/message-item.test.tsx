import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatMessageSchema } from "../../src/shared/chat-api.js";
import { MessageItem } from "../../src/web/chat/MessageItem.js";

it("renders persisted tool failures as expandable text and escapes their content", () => {
  const message = ChatMessageSchema.parse({
    id: "m",
    seq: 1,
    role: "assistant",
    content: "",
    attachments: [],
    tools: [
      {
        callId: "c",
        name: "submit_proposal",
        status: "done",
        isError: true,
        approval: null,
        error: "Proposal rejected: <source> is required",
      },
    ],
    status: "complete",
    error: null,
    createdAt: "",
  });
  const html = renderToStaticMarkup(
    <MessageItem message={message} text="" tools={message.tools} />,
  );
  expect(html).toContain("<summary>submit_proposal: error details</summary>");
  expect(html).toContain("Proposal rejected: &lt;source&gt; is required");
});
