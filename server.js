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
import emailVerificationRoutes from "./routes/email.routes.js";

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

        // Inside your switch statement, add this new case
        case "customer.subscription.deleted":
          subscription = event.data.object;
          customerId = subscription.customer;

          const deletedCustomer = await stripe.customers.retrieve(customerId);
          uid = deletedCustomer.metadata.uid;

          if (!uid) {
            console.log(
              "❌ UID missing in Stripe metadata for customer:",
              customerId
            );
            return res.status(400).json({ error: "UID not found in metadata" });
          }

          // Update subscription status to cancelled
          await updateDoc(doc(db, "subscriptions", uid), {
            status: "cancelled", // Note the spelling with double 'l'
            customerId: customerId,
            cancelledAt: new Date(), // Add timestamp when it was cancelled
            cancelReason: "Subscription deleted", // Optional reason
          });

          console.log(`✅ Subscription cancelled for user: ${uid}`);
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
              status: "cancelled",
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
    const { uid, priceId, email } = req.body;

    // 🔥 Create a Stripe Customer using UID in metadata
    const customer = await stripe.customers.create({
      name: `User-${uid}`,
      metadata: { uid },
      email,
      test_clock: "clock_1R8C5xJvljWkaejrVUwTOVJ2",
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

// ✅ Reactivate a Cancelled Stripe Subscription
app.post(
  "/api/stripe/reactivate-subscription",
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
      const { subscriptionId, status, cancelAtPeriodEnd } = subscriptionData;

      if (!subscriptionId) {
        console.log("❌ No Stripe subscription ID found for UID:", uid);
        return res
          .status(400)
          .json({ error: "No active subscription ID found" });
      }

      if (!cancelAtPeriodEnd) {
        console.log("❌ Subscription is not in cancelling state:", status);
        return res.status(400).json({
          error: "Only subscriptions pending cancellation can be reactivated",
        });
      }

      // Reactivate the subscription in Stripe by removing the cancellation at period end
      const reactivatedSubscription = await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: false }
      );

      // 🔥 Update subscription in Firestore
      await updateDoc(doc(db, "subscriptions", uid), {
        status: reactivatedSubscription.status,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
      });

      console.log("✅ Subscription reactivated successfully:", subscriptionId);

      return res.json({
        success: true,
        message: "Subscription has been successfully reactivated",
        data: {
          status: reactivatedSubscription.status,
          currentPeriodEnd: new Date(
            reactivatedSubscription.current_period_end * 1000
          ),
        },
      });
    } catch (error) {
      console.log("❌ Error reactivating subscription:", error.message);
      return res.status(400).json({ error: error.message });
    }
  }
);

// ✅ Update Payment Method for Stripe Subscription
app.post(
  "/api/stripe/update-payment-method",
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
      const { stripeCustomerId } = subscriptionData;

      if (!stripeCustomerId) {
        console.log("❌ No Stripe customer ID found for UID:", uid);
        return res.status(400).json({ error: "No Stripe customer ID found" });
      }

      // Create a SetupIntent to securely collect the customer's payment details
      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        usage: "off_session", // Important for subscriptions
      });

      console.log("✅ Setup intent created successfully:", setupIntent.id);

      return res.json({
        success: true,
        clientSecret: setupIntent.client_secret,
        customerId: stripeCustomerId,
      });
    } catch (error) {
      console.log("❌ Error creating setup intent:", error.message);
      return res.status(400).json({ error: error.message });
    }
  }
);

// ✅ Apply New Payment Method to Subscription
app.post(
  "/api/stripe/apply-payment-method",
  express.json(),
  async (req, res) => {
    try {
      const { uid, paymentMethodId } = req.body;

      if (!uid || !paymentMethodId) {
        console.log("❌ Missing required parameters");
        return res
          .status(400)
          .json({ error: "Both UID and paymentMethodId are required" });
      }

      // 🔥 Fetch subscription data from Firestore
      const subscriptionDoc = await getDoc(doc(db, "subscriptions", uid));

      if (!subscriptionDoc.exists()) {
        console.log("❌ No subscription found for UID:", uid);
        return res.status(404).json({ error: "No subscription found" });
      }

      const subscriptionData = subscriptionDoc.data();
      const { subscriptionId, stripeCustomerId } = subscriptionData;

      if (!subscriptionId || !stripeCustomerId) {
        console.log("❌ Missing subscription or customer ID for UID:", uid);
        return res.status(400).json({ error: "Invalid subscription data" });
      }

      // 1️⃣ Set the new payment method as the default for the customer
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      // 2️⃣ Update the subscription to use the new payment method
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        default_payment_method: paymentMethodId,
      });

      console.log(
        "✅ Payment method updated for subscription:",
        subscriptionId
      );

      // 3️⃣ Fetch the latest open invoice for the customer
      const invoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        limit: 1, // Get the latest invoice
      });

      const latestInvoice = invoices.data[0];

      // 4️⃣ If an unpaid invoice exists, attempt to pay it immediately
      if (latestInvoice && latestInvoice.status === "open") {
        try {
          const paidInvoice = await stripe.invoices.pay(latestInvoice.id);
          console.log("✅ Invoice paid successfully:", paidInvoice.id);
        } catch (error) {
          console.error("❌ Failed to pay invoice:", error.message);
        }
      }

      // 5️⃣ Update Firestore with payment method info
      await updateDoc(doc(db, "subscriptions", uid), {
        paymentMethodId: paymentMethodId,
        paymentMethodUpdatedAt: new Date(),
      });

      return res.json({
        success: true,
        message: "Payment method updated successfully",
        data: {
          status: subscription.status,
          paymentMethodId: paymentMethodId,
        },
      });
    } catch (error) {
      console.log("❌ Error updating payment method:", error.message);
      return res.status(400).json({ error: error.message });
    }
  }
);

// ✅ Updating Email
app.post("/api/stripe/update-email", express.json(), async (req, res) => {
  try {
    const { uid, newEmail } = req.body;

    if (!uid || !newEmail) {
      console.log("❌ Missing UID or email in request");
      return res.status(400).json({ error: "UID and new email are required" });
    }

    // 🔥 Fetch subscription data from Firestore
    const subscriptionDoc = await getDoc(doc(db, "subscriptions", uid));

    if (!subscriptionDoc.exists()) {
      console.log("❌ No subscription found for UID:", uid);
      return res.status(404).json({ error: "No subscription found" });
    }

    const { stripeCustomerId } = subscriptionDoc.data();

    if (!stripeCustomerId) {
      console.log("❌ No Stripe customer ID found for UID:", uid);
      return res.status(400).json({ error: "No Stripe customer ID found" });
    }

    // 🔥 Update email in Stripe
    const updatedCustomer = await stripe.customers.update(stripeCustomerId, {
      email: newEmail,
    });

    console.log("✅ Stripe email updated successfully:", updatedCustomer.email);

    return res.json({
      success: true,
      stripeEmail: updatedCustomer.email,
    });
  } catch (error) {
    console.log("❌ Error updating Stripe email:", error.message);
    return res.status(400).json({ error: error.message });
  }
});

app.use(express.json());
app.use("/api/email", emailVerificationRoutes);

// ✅ Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
