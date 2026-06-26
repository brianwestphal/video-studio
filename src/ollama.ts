// Ollama vision call: send one frame + prompt to a local model and return its
// description. This is a network/I/O boundary (it reads the frame off disk and
// calls the Ollama server), so it's covered by the manual test plan; the error
// classification it pairs with lives in resumable-error.ts and IS unit-tested.
import * as fs from "fs";
import ollama from "ollama";

export async function analyzeFrame(imagePath: string, prompt: string, model: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");

  const response = await ollama.chat({
    model,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [base64Image],
      },
    ],
  });

  return response.message.content.trim();
}
