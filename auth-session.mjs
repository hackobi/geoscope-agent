import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const CODE_FILE = "/tmp/tg-code.txt";
const PASSWORD_FILE = "/tmp/tg-password.txt";

// Clean up any old files
if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);
if (existsSync(PASSWORD_FILE)) unlinkSync(PASSWORD_FILE);

const client = new TelegramClient(
  new StringSession(""),
  API_ID,
  API_HASH,
  { connectionRetries: 5 }
);

console.log("Connecting to Telegram...");

await client.start({
  phoneNumber: async () => process.env.TELEGRAM_PHONE,
  password: async () => {
    console.log("\n>>> 2FA PASSWORD REQUIRED <<<");
    console.log(">>> Write your 2FA password to /tmp/tg-password.txt");
    console.log('>>> Example: echo "your2fapassword" > /tmp/tg-password.txt');
    console.log(">>> Waiting...");

    while (true) {
      if (existsSync(PASSWORD_FILE)) {
        const password = readFileSync(PASSWORD_FILE, "utf8").trim();
        if (password.length > 0) {
          console.log("Got 2FA password.");
          unlinkSync(PASSWORD_FILE);
          return password;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  },
  phoneCode: async () => {
    console.log("\n>>> CODE SENT to your Telegram app <<<");
    console.log(">>> Waiting for code in /tmp/tg-code.txt ...");

    // Poll for the code file
    while (true) {
      if (existsSync(CODE_FILE)) {
        const code = readFileSync(CODE_FILE, "utf8").trim();
        if (code.length >= 4) {
          console.log(`Got code: ${code}`);
          unlinkSync(CODE_FILE);
          return code;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  },
  onError: (err) => console.error("Error:", err.message),
});

const session = client.session.save();
writeFileSync(".telegram-session.txt", session);
console.log("\n✅ Session saved to .telegram-session.txt");
console.log(`Session length: ${session.length} chars`);

await client.disconnect();
process.exit(0);
