import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { type APIRequestContext, expect, test } from "./fixtures.js";
import { fixtures } from "../test/fixtures/scenarios.js";
import { profileInput } from "../test/helpers/chat.js";
import { type InferenceServer, startInferenceServer } from "../test/helpers/inference-server.js";

let inference: InferenceServer | undefined;
test.afterEach(async () => { await inference?.close(); inference=undefined; });
async function rebuild(request: APIRequestContext, origin: string) {
  const response=await request.post("/api/builds",{headers:{origin},data:{mode:"full"}});
  expect(response.status()).toBe(202);
  const {jobId}=await response.json();
  await expect.poll(async()=>(await (await request.get(`/api/jobs/${jobId}`)).json()).job.status).toBe("complete");
  const analytics=await request.get("/api/analytics?unit=strategy&currency=USD");
  expect(analytics.ok()).toBe(true);
  return (await analytics.json()).buildId as string;
}
test("chat export downloads full CSV and rejects the same link after rebuild",async({page,request,baseURL})=>{
  const origin=baseURL ?? "";
  const preview=await request.post("/api/imports/preview?timezone=UTC",{headers:{origin},multipart:{file:{name:"spread.csv",mimeType:"text/csv",buffer:Buffer.from(fixtures.spread)}}});
  expect(preview.ok()).toBe(true);
  const previewId=(await preview.json()).previews[0].id;
  expect((await request.post(`/api/imports/${previewId}/commit`,{headers:{origin}})).ok()).toBe(true);
  const buildId=await rebuild(request,origin);
  const href=`/api/analytics/export?dataset=transactions&unit=strategy&currency=USD&basis=broker&scope=closed&expectedBuildId=${buildId}`;
  inference=await startInferenceServer({mode:"tool-call",planGateTool:"get_pnl_summary",plan:[
    {kind:"tool-call",toolName:"export_analytics",arguments:{dataset:"transactions",unit:"strategy",currency:"USD",expectedBuildId:buildId}},
    {kind:"text",text:`[Download CSV](${href})\n\n[External](https://example.com/)\n\n[Reset](/api/maintenance/reset?expectedBuildId=${buildId})`},
  ]});
  const created=await request.post("/api/models",{headers:{origin},data:profileInput("export-browser",inference.url)});
  expect(created.ok()).toBe(true); const id=(await created.json()).profile.id;
  expect((await request.post(`/api/models/${id}/test`,{headers:{origin}})).ok()).toBe(true);
  expect((await request.post("/api/models/default",{headers:{origin},data:{id}})).ok()).toBe(true);
  let exportRequests=0;
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/analytics/export")exportRequests++;});
  await page.goto("/chat"); await page.getByTestId("new-thread").click();
  await page.getByTestId("composer-input").fill("Export my transactions"); await page.getByTestId("composer-send").click();
  const message=page.getByTestId("message-assistant").last();
  const link=message.getByRole("link",{name:"Download CSV"}); await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href",href); await expect(link).toHaveAttribute("download","");
  await expect(message.getByRole("link")).toHaveCount(1); expect(exportRequests).toBe(0);
  const downloading=page.waitForEvent("download"); await link.click(); const download=await downloading;
  expect(download.suggestedFilename()).toBe("trade-ledger-transactions-USD-all-time.csv");
  const path=await download.path(); if(!path)throw new Error("Missing download");
  const body=await readFile(path,"utf8");
  expect(parse(body,{columns:true}).length).toBeGreaterThan(0); expect(body).toContain('"-1402.23006"');
  const nextBuild=await rebuild(request,origin); expect(nextBuild).not.toBe(buildId);
  // Chromium cancels downloads for the endpoint's stale-build HTTP error.
  const rejectedDownload = page.waitForEvent("download");
  await link.click();
  const rejected = await rejectedDownload;
  expect(await rejected.failure()).toBe("canceled");
  const staleResponse = await request.get(href);
  expect(staleResponse.status()).toBe(409);
  expect(await staleResponse.json()).toMatchObject({code:"ANALYTICS_BUILD_CHANGED"});
});
