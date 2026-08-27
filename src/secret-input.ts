import type { ReadStream, WriteStream } from "node:tty";

export async function readHiddenInput(
  label: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    output.write(`${label}: `);
    let value = "";
    for await (const chunk of input) value += String(chunk);
    return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  }

  output.write(`${label}: `);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onInterrupt = () => finish(new Error("Secret input cancelled."));
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          onInterrupt();
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  });
}
