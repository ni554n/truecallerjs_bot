import type {
  ApiMethods,
  Opts,
  Update,
} from "https://deno.land/x/grammy_types@v3.1.2/mod.ts";
import {
  login,
  search,
  verifyOtp,
  type LoginResponse,
} from "https://esm.sh/truecallerjs@2.2.0";

type BotParams<METHOD extends keyof ApiMethods<unknown>> =
  Opts<unknown>[METHOD] & { method: METHOD };

type BotCommand =
  | "/start"
  | "/login"
  | "/installation_id"
  | "/logout"
  | "/stop"
  | "/info"
  | "/search";

let tgChatId: number | undefined;

/**
 * Receives webhook requests from Telegram.
 *
 * Must return a successful response, otherwise Telegram will periodically retry
 * the same message until it receives one. Later messages will be queued and
 * replayed after the successful response is received.
 */
Deno.serve(
  {
    // deno-lint-ignore no-explicit-any
    onError(error: any): Response {
      let message: string | undefined;

      if (error?.name === "AxiosError" && "response" in error) {
        message =
          error?.response?.data?.message || "Try again with a valid number.";
      } else {
        const reason =
          error instanceof Error ? `\nReason: ${error.message}` : "";

        message = `Internal server error!${reason}\nIt's been reported and will be fixed if possible.`;
      }

      reportError(error);

      return message ? sendTgMessage(message) : new Response();
    },
  },
  async (request: Request) => {
    if (request.method !== "POST") return new Response(null, { status: 404 });

    const { message, my_chat_member }: Update =
      (await request.json().catch(console.error)) ?? {};

    // "Delete & Block" command
    if (my_chat_member?.new_chat_member.status === "kicked") {
      const chatIdKey: [string, number] = ["users", my_chat_member.chat.id];

      const kv: Deno.Kv = await Deno.openKv();
      await kv.delete(chatIdKey);

      reportEvent("/stop");

      return new Response();
    }

    if (!message?.text) return new Response();

    tgChatId = message.chat.id;

    sendTypingIndicator();

    const kv: Deno.Kv = await Deno.openKv();

    const chatIdKey: [string, number] = ["users", tgChatId];

    type KvValue =
      | { status: "awaiting_phone_no" }
      | {
          status: "awaiting_otp";
          phoneNumber: string;
          loginResponse: LoginResponse;
        }
      | { status: "awaiting_installation_id" }
      | {
          status: "awaiting_country_code";
          installationId: string;
        }
      | {
          status: "logged_in";
          installationId: string;
          countryCode: string;
        }
      | { status: "logged_out" };

    const kvValue: KvValue = (await kv.get<KvValue>(chatIdKey)).value ?? {
      status: "logged_out",
    };

    if ((message.text as BotCommand) === "/start") {
      if (kvValue.status === "logged_out") reportEvent("/start");

      return sendTgMessage(
        "You need to /login to Truecaller with your existing account to use the bot.\nOnly you will be using your own account to search the numbers.",
      );
    }

    if ((message.text as BotCommand) === "/info") {
      let status: string;
      let installationId: string | undefined;

      if (kvValue.status === "logged_in") {
        status = "Logged in";
        installationId = kvValue.installationId;
      } else {
        status = "Logged out";
      }

      status = `*Status:* ${status}`;

      installationId = installationId
        ? `\n[Installation ID:](https://github.com/sumithemmadi/truecallerjs#simple-example) \`${installationId}\``
        : "";

      const about =
        "[Source Code](https://github.com/ni554n/truecallerjs_bot) *\\|* [anissan\\.com](https://anissan.com)";

      return sendTgMessage(`${status}${installationId}\n\n${about}`, true);
    }

    //#region Command: /installation_id

    if ((message.text as BotCommand) === "/installation_id") {
      if (kvValue.status === "logged_in") {
        return sendTgMessage(
          "You are already logged in.\n/logout first and then try again.",
        );
      }

      await kv.set(chatIdKey, {
        status: "awaiting_installation_id",
      } satisfies KvValue);

      return sendTgMessage(
        "_installation\\_id_ is the final auth token generated after a successful truecaller login\\.\n\nIf you know how to retrieve it from an already logged in device, you can directly set it here without going through the login process again\\.\n\nEnter the installation ID:",
        true,
      );
    }

    if (
      kvValue.status === "awaiting_installation_id" &&
      !message.text.startsWith("/")
    ) {
      const installationId = message.text;

      await kv.set(chatIdKey, {
        status: "awaiting_country_code",
        installationId,
      } satisfies KvValue);

      reportEvent("/installation_id");

      return sendTgMessage(
        "Enter your phone number's 2\\-letter [ISO country code](https://en.wikipedia.org/wiki/List_of_ISO_3166_country_codes):",
        true,
      );
    }

    if (
      kvValue.status === "awaiting_country_code" &&
      !message.text.startsWith("/")
    ) {
      const countryCode = message.text;

      await kv.set(chatIdKey, {
        status: "logged_in",
        installationId: kvValue.installationId,
        countryCode,
      } satisfies KvValue);

      return sendTgMessage(
        "Successfully logged in to Truecaller.\nYou can now search any number.",
      );
    }

    //#endregion /installation_id

    if ((message.text as BotCommand) === "/logout") {
      await kv.delete(chatIdKey);

      reportEvent("/logout");

      return sendTgMessage("You've been logged out");
    }

    //#region Command: /login

    if ((message.text as BotCommand) === "/login") {
      if (kvValue.status === "logged_in") {
        return sendTgMessage(
          "You are already logged in. /logout first and then try /login again.",
        );
      }

      await kv.set(chatIdKey, {
        status: "awaiting_phone_no",
      } satisfies KvValue);

      return sendTgMessage(
        "Enter your Truecaller account phone no. in international (+19...) format:",
      );
    }

    if (
      kvValue.status === "awaiting_phone_no" &&
      !message.text.startsWith("/")
    ) {
      const phoneNumber = message.text;

      if (!phoneNumber?.startsWith("+")) {
        return sendTgMessage(
          "Phone number should be in international format like +91...",
        );
      }

      const responseBody = await login(phoneNumber);

      if (responseBody.status === 6 || responseBody.status === 5) {
        return sendTgMessage(
          "You have exceeded the limit of verification attempts.\nPlease try again after some time (up to 24h).",
        );
      }

      if (
        !(
          responseBody.status === 1 ||
          responseBody.status === 9 ||
          responseBody.message === "Sent"
        )
      ) {
        return sendTgMessage(responseBody.message);
      }

      await kv.set(chatIdKey, {
        status: "awaiting_otp",
        phoneNumber,
        loginResponse: responseBody,
      } satisfies KvValue);

      return sendTgMessage("Enter the OTP from SMS or WhatsApp:");
    }

    if (kvValue.status === "awaiting_otp" && !message.text.startsWith("/")) {
      const otp = message.text;

      const otpResponse = (await verifyOtp(
        kvValue.phoneNumber,
        kvValue.loginResponse,
        otp,
      )) as Record<string, unknown>;

      if (otpResponse.suspended) {
        return sendTgMessage(
          "Your account has been suspended by Truecaller.\nTry to /login with another number.",
        );
      }

      if (otpResponse.status === 11) {
        return sendTgMessage("Invalid OTP");
      }

      if (otpResponse.status === 7) {
        return sendTgMessage("Retries limit exceeded");
      }

      if (!otpResponse.installationId) {
        return sendTgMessage(
          (otpResponse.message as string) || "Unknown error. Try again.",
        );
      }

      await kv.set(chatIdKey, {
        status: "logged_in",
        installationId: otpResponse.installationId as string,
        countryCode: kvValue.loginResponse.parsedCountryCode,
      } satisfies KvValue);

      reportEvent("/login");

      return sendTgMessage(
        "Successfully logged in to Truecaller.\nYou can now search any number.",
      );
    }

    //#endregion /login

    if (kvValue.status !== "logged_in") {
      return sendTgMessage("Please /login first before searching for a number");
    }

    const searchData = {
      number: message.text,
      countryCode: kvValue.countryCode,
      installationId: kvValue.installationId,
    };

    const searchResult = await search(searchData);

    // TruecallerJS wraps the Axios error instead of throwing it:
    // https://github.com/sumithemmadi/truecallerjs/blob/4a89a9ed71429900f60653291de4c64cc8fd50ab/src/search.ts#L204
    if (searchResult.json() instanceof Error) {
      // deno-lint-ignore no-explicit-any
      const error = searchResult.json() as any;
      const { status = "", message: apiMessage = "" } =
        error.response?.data ?? {};

      if (status === 40101 || status === 42601) {
        return sendTgMessage(
          `Truecaller responded with an account error: \`${apiMessage}\`\\.\n\nMake sure your account is still valid by login into the official app\\.\n\nTry to /login here again after checking\\.`,
          true,
        );
      }

      throw searchResult.json();
    }

    reportEvent("/search");

    return sendTgMessage(searchResult.getName());
  },
);

function sendTgMessage(text: string, formatted = false) {
  return new Response(
    JSON.stringify({
      method: "sendMessage",
      chat_id: tgChatId!,
      parse_mode: formatted ? "MarkdownV2" : undefined,
      disable_web_page_preview: true,
      text,
    } satisfies BotParams<"sendMessage">),
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function sendTypingIndicator(): void {
  fetch(
    `https://api.telegram.org/bot${Deno.env.get(
      "TG_THIS_BOT_TOKEN",
    )}/sendChatAction`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: tgChatId,
        action: "typing",
      }),
    },
  ).catch(console.error);
}

// Completely optional. Just for me to error logging and debugging.
function reportError(error: Error): void {
  const TG_REPORT_CHANNEL_ID = Deno.env.get("TG_REPORT_CHANNEL_ID");

  if (!TG_REPORT_CHANNEL_ID) {
    console.warn("Optional env var 'TG_REPORT_CHANNEL_ID' is not set.");
    return;
  }

  let details: string;

  if (error.name === "AxiosError" && "response" in error) {
    // deno-lint-ignore no-explicit-any
    const { config = {}, data = {} } = error.response as any;

    const url = config.url ?? "";
    const params = JSON.stringify(config.params ?? {}, null, 2);
    const requestData = JSON.stringify(config.data ?? {}, null, 2);
    const responseData = JSON.stringify(data, null, 2);

    details = `url: ${url}\n\nparams: ${params}\n\nreq_data: ${requestData}\n\nres_data: ${responseData}`;
  } else {
    details = `${error.stack}`;
  }

  // Telegram formatting rule:
  // https://core.telegram.org/bots/api#markdownv2-style
  details = `${tgChatId}: ${error.message}\n\n${details}`
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`");

  fetch(
    `https://api.telegram.org/bot${Deno.env.get(
      "TG_THIS_BOT_TOKEN",
    )}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TG_REPORT_CHANNEL_ID,
        parse_mode: "MarkdownV2",
        text: `${"```"}\n${details}\n${"```"}`,
      }),
    },
  ).catch(console.error);
}

function reportEvent(eventName: BotCommand): void {
  const EVENT_PING_URL = Deno.env.get("EVENT_PING_URL");
  const EVENT_PING_PROJECT_ID = Deno.env.get("EVENT_PING_PROJECT_ID");

  if (!(EVENT_PING_URL && EVENT_PING_PROJECT_ID)) {
    console.warn("Optional env vars 'EVENT_PING_*' are not set.");
    return;
  }

  fetch(EVENT_PING_URL, {
    method: "POST",
    headers: {
      "User-Agent": "telegram (@;truecallerjs)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "event",
      payload: {
        website: Deno.env.get("EVENT_PING_PROJECT_ID"),
        url: eventName,
      },
    }),
  }).catch(reportError);
}
