import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import stripeLib from "stripe";
import { db } from "./firebase.js";
import { collection, doc, setDoc, updateDoc } from "firebase/firestore";

dotenv.config();
const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());

// ✅ Stripe Webhook to Track Subscriptions
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_KEY
      );
    } catch (err) {
      console.log(process.env.STRIPE_WEBHOOK_KEY);

      console.log("❌ Webhook Signature Error:", err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    console.log("🔔 Webhook event received:", event.type);

    try {
      let customerId, uid, subscription;

      switch (event.type) {
        case "invoice.payment_succeeded":
          const invoice = event.data.object;
          customerId = invoice.customer;

          // 🔥 Retrieve UID from Stripe Customer Metadata
          const customer = await stripe.customers.retrieve(customerId);
          uid = customer.metadata.uid;

          if (!uid) {
            console.log("❌ UID missing in Stripe metadata");
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          await updateDoc(doc(db, "subscriptions", uid), {
            status: "active",
            lastPaymentDate: new Date(),
          });
          break;

        case "customer.subscription.updated":
          subscription = event.data.object;
          customerId = subscription.customer;

          // 🔥 Retrieve UID from Stripe Customer Metadata
          const updatedCustomer = await stripe.customers.retrieve(customerId);
          uid = updatedCustomer.metadata.uid;

          if (!uid) {
            console.log("❌ UID missing in Stripe metadata");
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          await updateDoc(doc(db, "subscriptions", uid), {
            status: subscription.status,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          });
          break;

        case "customer.subscription.deleted":
          subscription = event.data.object;
          customerId = subscription.customer;

          // 🔥 Retrieve UID from Stripe Customer Metadata
          const deletedCustomer = await stripe.customers.retrieve(customerId);
          uid = deletedCustomer.metadata.uid;

          if (!uid) {
            console.log("❌ UID missing in Stripe metadata");
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          await updateDoc(doc(db, "subscriptions", uid), {
            status: "canceled",
          });
          break;

        default:
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }

      res.sendStatus(200);
    } catch (error) {
      console.log("❌ Firestore Update Error:", error.message);
      res.status(400).json({ error: error.message });
    }
  }
);
// ✅ Create Stripe Payment Intent for Subscription
app.post("/api/stripe/payment-sheet", express.json(), async (req, res) => {
  try {
    const { uid, priceId } = req.body;

    // 🔥 Create a Stripe Customer using UID in metadata
    const customer = await stripe.customers.create({
      name: `User-${uid}`, // Placeholder since email is missing
      metadata: { uid }, // Store UID for reference
    });

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    });

    res.json({
      paymentIntent: subscription.latest_invoice.payment_intent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      subscriptionId: subscription.id,
    });

    // 🔥 Save Subscription in Firestore (Using UID)
    await setDoc(doc(collection(db, "subscriptions"), uid), {
      uid,
      status: "pending",
      stripeCustomerId: customer.id,
      subscriptionId: subscription.id,
      currentPeriodEnd: null,
    });
  } catch (error) {
    console.log("Error", error.message);

    res.status(400).json({ error: error.message });
  }
});

// ✅ Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
