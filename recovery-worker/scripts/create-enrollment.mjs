import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

var args = process.argv.slice(2);
var outputIndex = args.indexOf("--output");
var summaryOutputIndex = args.indexOf("--summary-output");
var teamIndex = args.indexOf("--team");
var maxUsesIndex = args.indexOf("--max-uses");
var expiresDaysIndex = args.indexOf("--expires-days");
var output = outputIndex > -1 ? args[outputIndex + 1] : "";
var summaryOutput = summaryOutputIndex > -1 ? args[summaryOutputIndex + 1] : "";
var teamId = teamIndex > -1 ? args[teamIndex + 1] : "preplot-team";
var maxUses = maxUsesIndex > -1 ? Number(args[maxUsesIndex + 1]) : 1;
var expiresDays = expiresDaysIndex > -1 ? Number(args[expiresDaysIndex + 1]) : 365;
if(!output) throw new Error("Use --output <path> so the enrollment record is not printed to the terminal");
if(!/^[A-Za-z0-9_-]{8,100}$/.test(teamId)) throw new Error("Team id is invalid");
if(!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new Error("Max uses must be an integer from 1 to 100");
if(!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650) throw new Error("Expiry must be an integer from 1 to 3650 days");

var raw = randomBytes(18).toString("hex").toUpperCase();
var code = "PREPLOT-" + raw.match(/.{1,6}/g).join("-");
var hash = createHash("sha256").update(code).digest("hex");
var issuedAt = new Date();
var expiresAt = new Date(issuedAt.getTime() + expiresDays * 24 * 60 * 60 * 1000);
var record = {
  teamId:teamId,
  enrollmentId:randomUUID(),
  issuedAt:issuedAt.toISOString(),
  expiresAt:expiresAt.toISOString(),
  maxUses:maxUses,
  useCount:0,
  uses:[]
};
await writeFile(output,JSON.stringify(record,null,2) + "\n",{mode:0o600});
var summary = {
  code:code,
  objectKey:"enrollments/" + hash + ".json",
  output:output,
  expiresAt:record.expiresAt,
  expiresDays:expiresDays,
  maxUses:maxUses
};
if(summaryOutput){
  await writeFile(summaryOutput,JSON.stringify(summary,null,2) + "\n",{mode:0o600});
  process.stdout.write(JSON.stringify({created:true,summaryOutput:summaryOutput,expiresAt:record.expiresAt,expiresDays:expiresDays,maxUses:maxUses}) + "\n");
} else {
  process.stdout.write(JSON.stringify(summary) + "\n");
}
