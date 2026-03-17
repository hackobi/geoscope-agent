// Vision OCR for tweet screenshots and images
// Uses OpenAI GPT-4o-mini for vision (DeepSeek API does not support image inputs)

import OpenAI from "openai";

let visionClient;
// Only OpenAI supports vision/image inputs — DeepSeek does not
if (process.env.OPENAI_API_KEY) {
  visionClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  visionClient = null;
}

export async function extractTextFromImage(imageBuffer) {
  if (!visionClient) {
    console.warn("Vision OCR requires OPENAI_API_KEY — skipping image");
    return null;
  }

  const base64 = imageBuffer.toString("base64");
  const dataUri = `data:image/jpeg;base64,${base64}`;

  try {
    const model = "gpt-4o-mini";
    const response = await visionClient.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUri },
            },
            {
              type: "text",
              text: "Extract the text from this tweet screenshot. Return only the tweet text and author. If this is not a tweet screenshot, extract whatever text is visible.",
            },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.1,
    });

    const extracted = response.choices[0]?.message?.content?.trim();
    if (!extracted || extracted.length < 10) return null;
    return extracted;
  } catch (err) {
    console.warn("Vision OCR failed:", err.message);
    return null;
  }
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB limit

export async function downloadAndExtract(telegramClient, message) {
  try {
    const buffer = await telegramClient.downloadMedia(message.media);
    if (!buffer || buffer.length === 0) return null;
    if (buffer.length > MAX_IMAGE_SIZE) {
      console.warn(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB), skipping OCR for msg ${message.id}`);
      return null;
    }
    return await extractTextFromImage(buffer);
  } catch (err) {
    console.warn(`Image download/extract failed for msg ${message.id}:`, err.message);
    return null;
  }
}
