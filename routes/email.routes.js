import express from "express";
import nodemailer from "nodemailer";
import {
  getDoc,
  doc,
  updateDoc,
  setDoc,
  query,
  collection,
  where,
  getDocs,
} from "firebase/firestore";
import { db } from "../firebase.js";

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Generate a 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Email Verification Routes
const emailVerificationRoutes = express.Router();

// Request OTP
emailVerificationRoutes.post("/request-otp", async (req, res) => {
  try {
    const { uid, email } = req.body;

    // Validate input
    if (!uid || !email) {
      return res.status(400).json({
        success: false,
        error: "User ID and email are required",
      });
    }

    // Check if any other user has the same email
    const emailQuery = query(
      collection(db, "email_verification"),
      where("email", "==", email)
    );
    const emailQuerySnapshot = await getDocs(emailQuery);

    let emailExists = false;
    emailQuerySnapshot.forEach((doc) => {
      if (doc.id !== uid) {
        emailExists = true;
      }
    });

    if (emailExists) {
      return res.status(400).json({
        success: false,
        error: "This email is already associated with another account.",
      });
    }

    // Fetch the existing OTP document
    const userDoc = await getDoc(doc(db, "email_verification", uid));
    if (userDoc.exists()) {
      const userData = userDoc.data();
      const currentTime = Date.now();
      const existingOtpExpiry = userData.otpExpiry || 0;

      // Check if OTP is still valid
      if (currentTime < existingOtpExpiry) {
        return res.status(400).json({
          success: false,
          error:
            "An OTP has already been sent. Please try again later after 15 minutes.",
        });
      }
    }

    // Generate a new OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

    // Store OTP in Firestore
    await setDoc(
      doc(db, "email_verification", uid),
      {
        email,
        otp,
        otpExpiry: otpExpiry.getTime(),
        verified: false,
      },
      { merge: true }
    );

    // Send OTP via email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Email Verification OTP",
      text: `Your verification OTP is: ${otp}. 
        This OTP will expire in 15 minutes.`,
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Email Verification</h2>
            <p>Your verification OTP is:</p>
            <h1 style="background-color: #f0f0f0; padding: 10px; text-align: center; letter-spacing: 10px;">${otp}</h1>
            <p>This OTP will expire in 15 minutes.</p>
          </div>
        `,
    });

    return res.json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
    console.error("OTP Request Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to send OTP",
    });
  }
});

// Verify OTP
emailVerificationRoutes.post("/verify-otp", async (req, res) => {
  try {
    const { uid, otp } = req.body;

    // Validate input
    if (!uid || !otp) {
      return res.status(400).json({
        success: false,
        error: "User ID and OTP are required",
      });
    }

    // Retrieve stored verification data
    const verificationDoc = await getDoc(doc(db, "email_verification", uid));

    if (!verificationDoc.exists()) {
      return res.status(404).json({
        success: false,
        error: "No OTP request found",
      });
    }

    const { otp: storedOtp, otpExpiry, email } = verificationDoc.data();

    // Check OTP expiry
    if (new Date().getTime() > otpExpiry) {
      return res.status(400).json({
        success: false,
        error: "OTP has expired",
      });
    }

    // Verify OTP
    if (otp !== storedOtp) {
      return res.status(400).json({
        success: false,
        error: "Invalid OTP",
      });
    }

    // Mark email as verified in user document
    await updateDoc(doc(db, "Users", uid), {
      emailVerified: true,
      verifiedEmail: email,
    });

    // Clear verification document
    await updateDoc(doc(db, "email_verification", uid), {
      verified: true,
      otp: null,
      otpExpiry: null,
    });

    return res.json({
      success: true,
      message: "Email verified successfully",
      newEmail: email,
    });
  } catch (error) {
    console.error("OTP Verification Error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to verify OTP",
    });
  }
});

export default emailVerificationRoutes;
