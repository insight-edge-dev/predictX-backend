/**
 * smsRoutes.js
 *
 * POST /api/auth/sms-hook
 *   Called by Supabase as a custom SMS provider webhook.
 *   Supabase sends: { phone, otp }  (or nested { user.phone, sms.otp })
 *   We forward to jskbulkmarketing.in and return 200.
 *
 * Configure in Supabase Dashboard:
 *   Authentication → Providers → Phone → SMS Provider → Custom
 *   Webhook URL: https://cricketiq-backend-elrd.onrender.com/api/auth/sms-hook
 */

const express = require("express");
const axios   = require("axios");

const router = express.Router();

const SMS_URL = "https://jskbulkmarketing.in/app/smsapi/index.php";

router.post("/auth/sms-hook", async (req, res) => {
  // Supabase can send two different shapes — handle both
  const phone = req.body.phone || req.body.user?.phone;
  const otp   = req.body.otp   || req.body.sms?.otp;

  console.log(`[SMSHook] Sending OTP to ${phone}`);

  if (!phone || !otp) {
    console.error("[SMSHook] Missing phone or otp. Body:", req.body);
    return res.status(400).json({ error: "Missing phone or otp" });
  }

  // Strip country code — API expects 10-digit Indian mobile number
  const digits = phone.replace(/\D/g, "");
  const mobile = digits.length > 10 ? digits.slice(-10) : digits;

  const msg = `Dear User, your OTP for Paco Innovations LLP login is ${otp}. OTP valid for 10 minutes. Please do not share it with anyone.`;

  try {
    const { data } = await axios.get(SMS_URL, {
      params: {
        key:      process.env.SMS_API_KEY,
        campaign: process.env.SMS_CAMPAIGN_ID,
        routeid:  process.env.SMS_ROUTE_ID,
        type:     "text",
        contacts: mobile,
        senderid: process.env.SMS_SENDER_ID || "PACOIN",
        msg,
      },
      timeout: 10_000,
    });

    console.log(`[SMSHook] API response for ${mobile}:`, String(data).slice(0, 100));
    return res.json({ message_id: String(data) });
  } catch (e) {
    console.error("[SMSHook] Send failed:", e.message);
    return res.status(500).json({ error: "SMS delivery failed" });
  }
});

module.exports = router;
