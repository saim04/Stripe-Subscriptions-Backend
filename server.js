import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import stripeLib from "stripe";
import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  addDoc,
  getDoc,
} from "firebase/firestore";

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

    if (!sig) {
      console.log("❌ Missing Stripe signature header");
      return res
        .status(400)
        .json({ error: "Webhook Error: Missing signature" });
    }

    if (!process.env.STRIPE_WEBHOOK_KEY) {
      console.log("❌ Missing STRIPE_WEBHOOK_SECRET environment variable");
      return res.status(500).json({ error: "Server configuration error" });
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_KEY
      );
    } catch (err) {
      console.log(`❌ Webhook Signature Error: ${err.message}`);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    console.log("🔔 Webhook event received:", event.type);

    try {
      let customerId, uid, subscription, invoice;

      switch (event.type) {
        // Initial subscription creation
        case "customer.subscription.created":
          subscription = event.data.object;
          customerId = subscription.customer;

          const newCustomer = await stripe.customers.retrieve(customerId);
          uid = newCustomer.metadata.uid;

          if (!uid) {
            console.log(
              "❌ UID missing in Stripe metadata for customer:",
              customerId
            );
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          await updateDoc(doc(db, "subscriptions", uid), {
            status: subscription.status,
            planId: subscription.items.data[0].price.id,
            subscriptionId: subscription.id,
            customerId: customerId, // Store the Stripe customer ID
            createdAt: new Date(subscription.created * 1000),
            currentPeriodStart: new Date(
              subscription.current_period_start * 1000
            ),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          });

          // Also store the customer ID in the user document for easier access
          // await updateDoc(doc(db, "users", uid), {
          //   stripeCustomerId: customerId
          // });
          break;

        // When a subscription is updated (plan change, trial end, etc.)
        case "customer.subscription.updated":
          subscription = event.data.object;
          customerId = subscription.customer;

          const updatedCustomer = await stripe.customers.retrieve(customerId);
          uid = updatedCustomer.metadata.uid;

          if (!uid) {
            console.log(
              "❌ UID missing in Stripe metadata for customer:",
              customerId
            );
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          await updateDoc(doc(db, "subscriptions", uid), {
            status: subscription.status,
            planId: subscription.items.data[0].price.id,
            customerId: customerId, // Ensure customer ID is updated/stored
            currentPeriodStart: new Date(
              subscription.current_period_start * 1000
            ),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          });
          break;

        // When a payment is successful (initial or renewal)
        case "invoice.payment_succeeded":
          invoice = event.data.object;
          customerId = invoice.customer;

          const paidCustomer = await stripe.customers.retrieve(customerId);
          uid = paidCustomer.metadata.uid;

          if (!uid) {
            console.log(
              "❌ UID missing in Stripe metadata for customer:",
              customerId
            );
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          // Check if this is a subscription-related invoice
          if (invoice.subscription) {
            await updateDoc(doc(db, "subscriptions", uid), {
              status: "active",
              customerId: customerId, // Ensure customer ID is stored
              lastPaymentDate: new Date(invoice.created * 1000),
              lastPaymentAmount: invoice.amount_paid,
              invoicePdf: invoice.invoice_pdf,
            });

            // Add payment history
            //   await addDoc(collection(db, "Users", uid, "paymentHistory"), {
            //     invoiceId: invoice.id,
            //     customerId: customerId, // Store customer ID with payment history
            //     amount: invoice.amount_paid,
            //     currency: invoice.currency,
            //     date: new Date(invoice.created * 1000),
            //     receiptUrl: invoice.hosted_invoice_url,
            //     status: "paid",
            //   });
          }
          break;

        // When a payment fails
        case "invoice.payment_failed":
          invoice = event.data.object;
          customerId = invoice.customer;

          const failedCustomer = await stripe.customers.retrieve(customerId);
          uid = failedCustomer.metadata.uid;

          if (!uid) {
            console.log(
              "❌ UID missing in Stripe metadata for customer:",
              customerId
            );
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          // Update subscription status
          if (invoice.subscription) {
            await updateDoc(doc(db, "subscriptions", uid), {
              status: "past_due",
              customerId: customerId, // Ensure customer ID is stored
              lastFailedPaymentDate: new Date(invoice.created * 1000),
            });

            // Add to payment history
            //   await addDoc(collection(db, "users", uid, "paymentHistory"), {
            //     invoiceId: invoice.id,
            //     customerId: customerId, // Store customer ID with payment history
            //     amount: invoice.amount_due,
            //     currency: invoice.currency,
            //     date: new Date(invoice.created * 1000),
            //     failureReason:
            //       invoice.last_payment_error?.message || "Payment failed",
            //     status: "failed",
            //   });
          }
          break;

        // Leave other event handlers unchanged
        default:
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.log("❌ Firestore Update Error:", error.message);
      return res.status(400).json({ error: error.message });
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

// ✅ Cancel a Stripe Subscription
app.post(
  "/api/stripe/cancel-subscription",
  express.json(),
  async (req, res) => {
    try {
      const { uid } = req.body;

      if (!uid) {
        console.log("❌ Missing UID in request");
        return res.status(400).json({ error: "UID is required" });
      }

      // 🔥 Fetch subscription data from Firestore
      const subscriptionDoc = await getDoc(doc(db, "subscriptions", uid));

      if (!subscriptionDoc.exists()) {
        console.log("❌ No subscription found for UID:", uid);
        return res.status(404).json({ error: "No subscription found" });
      }

      const subscriptionData = subscriptionDoc.data();
      const { subscriptionId, stripeCustomerId } = subscriptionData;

      if (!subscriptionId) {
        console.log("❌ No Stripe subscription ID found for UID:", uid);
        return res
          .status(400)
          .json({ error: "No active subscription ID found" });
      }

      // Cancel the subscription in Stripe (can be immediate or at period end)
      // Set cancel_at_period_end: true to cancel at end of billing period
      // Remove that parameter for immediate cancellation
      const cancelledSubscription = await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true }
      );

      // 🔥 Update subscription in Firestore
      await updateDoc(doc(db, "subscriptions", uid), {
        status: "cancelling",
        cancelAtPeriodEnd: true,
        cancelledAt: new Date(),
        currentPeriodEnd: new Date(
          cancelledSubscription.current_period_end * 1000
        ),
      });

      console.log("✅ Subscription cancelled successfully:", subscriptionId);

      return res.json({
        success: true,
        message:
          "Subscription will be cancelled at the end of the billing period",
        data: {
          status: "cancelling",
          currentPeriodEnd: new Date(
            cancelledSubscription.current_period_end * 1000
          ),
        },
      });
    } catch (error) {
      console.log("❌ Error cancelling subscription:", error.message);
      return res.status(400).json({ error: error.message });
    }
  }
);

// ✅ Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
