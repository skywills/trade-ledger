import {spawn} from "node:child_process";
import {createServer} from "node:net";
export async function startDashboardServer():Promise<{origin:string;close:()=>Promise<void>}>{
 const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));const address=reservation.address();if(!address||typeof address==="string")throw new Error("No temporary port");const port=address.port;await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
 const child=spawn(process.execPath,["scripts/e2e-server.mjs"],{cwd:process.cwd(),env:{...process.env,E2E_PORT:String(port)},stdio:["ignore","ignore","pipe"]});
 const origin=`http://localhost:${port}`;let stderr="";child.stderr.on("data",chunk=>{stderr+=String(chunk);});
 const close=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGTERM");await exited;};
 for(let attempt=0;attempt<200;attempt++){if(child.exitCode!==null)throw new Error(`Isolated server exited: ${stderr}`);try{if((await fetch(`${origin}/health/live`)).ok)return {origin,close};}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
 await close();throw new Error(`Isolated server did not start: ${stderr}`);
}
