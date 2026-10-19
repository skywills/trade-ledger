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

it("shows streamed thinking in its own expandable block above the answer", () => {
  const message = ChatMessageSchema.parse({
    id: "m",
    seq: 1,
    role: "assistant",
    content: "",
    thinking: "",
    attachments: [],
    tools: [],
    status: "streaming",
    error: null,
    createdAt: "",
  });
  const html = renderToStaticMarkup(
    <MessageItem
      message={message}
      text="Partial answer"
      thinking="Checking <trade> records"
      tools={[]}
    />,
  );
  expect(html).toContain('<details class="thinking-block" open="">');
  expect(html).toContain("Checking &lt;trade&gt; records");
  expect(html.indexOf("Checking &lt;trade&gt; records")).toBeLessThan(
    html.indexOf("Partial answer"),
  );
  expect(html).not.toContain("<trade>");
});

it("offers tool activity without inventing thinking when the provider sends none", () => {
  const message = ChatMessageSchema.parse({
    id: "m",
    seq: 1,
    role: "assistant",
    content: "",
    attachments: [],
    tools: [
      {
        callId: "c",
        name: "list_review_issues",
        status: "running",
        isError: false,
        approval: null,
      },
    ],
    status: "streaming",
    error: null,
    createdAt: "",
  });
  const html = renderToStaticMarkup(
    <MessageItem message={message} text="" tools={message.tools} />,
  );
  expect(html).toContain('class="thinking-block"');
  expect(html).toContain("list_review_issues");
  expect(html).toContain(
    "Waiting for thinking or response text from the model.",
  );
});
