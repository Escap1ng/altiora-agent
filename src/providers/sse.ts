export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  function takeEvent(): string | null {
    if (data.length === 0) return null;
    const payload = data.join("\n");
    data = [];
    return payload;
  }

  function consume(line: string): string | null {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return takeEvent();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    return null;
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = consume(line);
      if (event !== null) yield event;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    const event = consume(buffer);
    if (event !== null) yield event;
  }
  const tail = takeEvent();
  if (tail !== null) yield tail;
}
