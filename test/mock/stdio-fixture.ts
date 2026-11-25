const mode = process.argv[2] ?? "echo";

if (mode === "crash") {
  process.stdout.write("not json\n");
  process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  process.stderr.write("fixture crash\n");
  process.exit(3);
}

if (mode === "probe") {
  const params = { cwd: process.cwd(), marker: process.env["ALTIORA_MCP_TEST"] ?? null };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "probe", params })}\n`);
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line !== "") process.stdout.write(`${line}\n`);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));