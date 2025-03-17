import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import stripeLib from "stripe";
import { db } from "./firebase.js";
import { collection, doc, setDoc, updateDoc } from "firebase/firestore";
import bodyParser from "body-parser";

dotenv.config();
const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: "application/json" }));

// ✅ Create Stripe Payment Intent for Subscription
app.post("/api/stripe/payment-sheet", async (req, res) => {
  try {
    const { email, priceId } = req.body;

    const customer = await stripe.customers.create({ email });
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

    // 🔥 Save Subscription in Firestore
    await setDoc(doc(collection(db, "subscriptions"), customer.id), {
      email,
      status: "pending",
      subscriptionId: subscription.id,
      currentPeriodEnd: null,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ✅ Stripe Webhook to Track Subscriptions
app.post("/api/stripe/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case "invoice.payment_succeeded":
      const paymentIntent = event.data.object;
      await updateDoc(doc(db, "subscriptions", paymentIntent.customer), {
        status: "active",
        lastPaymentDate: new Date(),
      });
      break;

    case "customer.subscription.updated":
      const subscription = event.data.object;
      await updateDoc(doc(db, "subscriptions", subscription.customer), {
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      });
      break;

    case "customer.subscription.deleted":
      const canceledSubscription = event.data.object;
      await updateDoc(doc(db, "subscriptions", canceledSubscription.customer), {
        status: "canceled",
      });
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.sendStatus(200);
});

// ✅ Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
