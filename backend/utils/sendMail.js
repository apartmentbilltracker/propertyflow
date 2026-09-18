const nodemailer = require("nodemailer");
const sgMail = require("@sendgrid/mail");

const getEnv = (...keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
};

const fetchJson = async (url, options) => {
  const fetchFn =
    global.fetch ||
    ((...args) =>
      import("node-fetch").then(({ default: fetch }) => fetch(...args)));
  const response = await fetchFn(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }

  if (!response.ok) {
    const details =
      typeof body === "string"
        ? body
        : body?.message || body?.error || JSON.stringify(body);
    throw new Error(`${response.status} ${response.statusText}: ${details}`);
  }

  return body;
};

const stripHtml = (html = "") =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getSender = () => {
  const email = getEnv(
    "EMAIL_FROM",
    "MAIL_FROM",
    "SENDGRID_FROM_EMAIL",
    "BREVO_FROM_EMAIL",
    "RESEND_FROM_EMAIL",
    "SMTP_FROM",
    "SMTP_USER",
    "SMTP_MAIL",
    "SMPT_MAIL",
  );
  const name = getEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME") || "PropFlow";
  return { email, name };
};

const isEnabled = (value) =>
  !["false", "0", "off", "disabled"].includes(String(value).toLowerCase());

const providerOrder = () => {
  const configured = getEnv("EMAIL_PROVIDER_ORDER", "MAIL_PROVIDER_ORDER");
  if (configured) {
    return configured
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }
  return ["sendgrid", "brevo", "resend", "smtp"];
};

const sendWithSendGrid = async (mail) => {
  const apiKey = getEnv("SENDGRID_API_KEY");
  if (!apiKey) throw new Error("SENDGRID_API_KEY is not configured");

  sgMail.setApiKey(apiKey);
  await sgMail.send({
    to: mail.to,
    from: mail.from,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
};

const sendWithBrevo = async (mail) => {
  const apiKey = getEnv("BREVO_API_KEY", "SENDINBLUE_API_KEY");
  if (!apiKey) throw new Error("BREVO_API_KEY is not configured");

  await fetchJson("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: mail.from,
      to: [{ email: mail.to }],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
    }),
  });
};

const sendWithResend = async (mail) => {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");

  await fetchJson("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `${mail.from.name} <${mail.from.email}>`,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
};

const sendWithSmtp = async (mail) => {
  const user = getEnv("SMTP_USER", "SMTP_MAIL", "SMPT_MAIL");
  const pass = getEnv("SMTP_PASS", "SMTP_PASSWORD", "SMPT_PASSWORD");
  if (!user || !pass) {
    throw new Error("SMTP credentials are not configured");
  }

  const service = getEnv("SMTP_SERVICE", "SMPT_SERVICE");
  const host = getEnv("SMTP_HOST", "SMPT_HOST");
  const port = Number(getEnv("SMTP_PORT", "SMPT_PORT") || 465);
  const secureEnv = getEnv("SMTP_SECURE", "SMPT_SECURE");
  const secure = secureEnv ? isEnabled(secureEnv) : port === 465;

  const transportConfig =
    service || !host
      ? { service: service || "gmail", auth: { user, pass } }
      : {
          host,
          port,
          secure,
          auth: { user, pass },
        };

  const transporter = nodemailer.createTransport(transportConfig);
  await transporter.sendMail({
    from: `"${mail.from.name}" <${mail.from.email || user}>`,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
};

const providers = {
  sendgrid: sendWithSendGrid,
  brevo: sendWithBrevo,
  resend: sendWithResend,
  smtp: sendWithSmtp,
  gmail: sendWithSmtp,
};

const sendMail = async (options) => {
  const to = options.email || options.to;
  if (!to) throw new Error("Email recipient is required");

  const sender = getSender();
  const smtpUser = getEnv("SMTP_USER", "SMTP_MAIL", "SMPT_MAIL");
  const mail = {
    to,
    from: {
      email: sender.email || smtpUser,
      name: sender.name,
    },
    subject: options.subject,
    html: options.message || options.html || "",
    text: options.text || stripHtml(options.message || options.html || ""),
  };

  if (!mail.from.email) {
    throw new Error(
      "Email sender is not configured. Set EMAIL_FROM, SMTP_FROM, or SMTP_USER.",
    );
  }

  const attempts = [];
  for (const providerName of providerOrder()) {
    const provider = providers[providerName];
    if (!provider) continue;
    try {
      await provider(mail);
      console.log(`[Email] Sent to ${to} via ${providerName}`);
      return { success: true, provider: providerName };
    } catch (error) {
      attempts.push(`${providerName}: ${error.message}`);
      console.error(`[Email] ${providerName} failed:`, error.message);
    }
  }

  const message = attempts.length
    ? `All email providers failed. ${attempts.join(" | ")}`
    : "No supported email providers are configured.";
  throw new Error(message);
};

module.exports = sendMail;
