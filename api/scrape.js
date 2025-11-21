import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const username = (req.query.user || req.query.u || '')
      .toString()
      .trim()
      .replace(/^@/, '');

    if (!username)
      return res.status(400).json({ error: "Missing user parameter" });

    const target = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    const proxy = process.env.PROXY_URL || "";
    const urlToFetch = proxy ? `${proxy}${encodeURIComponent(target)}` : target;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Appl
