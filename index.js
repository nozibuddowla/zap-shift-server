require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const admin = require("firebase-admin");

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // This is what Vercel will use
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // This is what you will use locally
    serviceAccount = require("./zap-shift-firebase-adminsdk.json");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} catch (error) {
  console.error("Firebase Admin Initialization Error:", error.message);
}

const generateTrackingId = () => {
  const prefix = "ZAP";
  const timestamp = Date.now().toString().slice(-8);
  const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp}-${randomStr}`;
};

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .send({ message: "Unauthorized access - No token provided" });
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    if (!admin.apps.length) {
      return res.status(500).send({message: "Firebase not initialized"})
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    // console.log("decoded in the token", decodedToken);

    req.user = decodedToken;
    req.decoded_email = decodedToken.email;
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res
      .status(401)
      .send({ message: "Unauthorized access - Invalid token" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@simple-curd-cluster.oq47ln2.mongodb.net/?appName=simple-curd-cluster`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const parcelDB = client.db("zapShiftDB");
    const usersCollection = parcelDB.collection("users");
    const parcelsCollection = parcelDB.collection("parcels");
    const paymentCollection = parcelDB.collection("payments");

    //   parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: "Invalid ID" });
      }
      const query = { _id: new ObjectId(id) };

      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (req.decoded_email !== email) {
        return res.status(403).send({ message: "Forbidden access" });
      }

      const query = { customerEmail: email };

      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const result = await parcelsCollection.insertOne(parcel);
      res.status(201).send(result);
    });

    // payment related apis
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        const amount = parseInt(paymentInfo.cost);

        if (isNaN(amount) || amount <= 0) {
          return res.status(400).send({ error: "Invalid cost amount" });
        }

        const successUrl =
          paymentInfo.successUrl ||
          `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl =
          paymentInfo.cancelUrl ||
          `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`;

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: amount * 100,
                product_data: {
                  name:
                    `Please pay for: ${paymentInfo.parcelName}` ||
                    "Parcel Delivery",
                },
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
          },
          customer_email: paymentInfo.senderEmail,
          success_url: successUrl,
          cancel_url: cancelUrl,
        });

        res.send({ id: session.id, url: session.url });
      } catch (error) {
        console.error("Stripe error:", error);

        res.status(500).send({ error: error.message });
      }
    });

    app.post("/users", async (req, res) => {
      try {
        const user = req.body;

        const query = { email: user.email };
        const existingUser = await usersCollection.findOne(query);
        if (existingUser) {
          return res.send({ message: "User already exists", insertedId: null });
        }

        const newUser = {
          displayName: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
          role: "user",
          createdAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).send({ error: "Failed to save user" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: "Invalid ID format" });
      }
      const query = { _id: new ObjectId(id) };
      try {
        const result = await parcelsCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to delete parcel" });
      }
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const { session_id } = req.query;
        if (!session_id) {
          return res.status(400).send({ error: "No session ID" });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        // console.log("session retrieved", session);

        if (session.payment_status === "paid") {
          const parcelId = session.metadata.parcelId;
          const query = { _id: new ObjectId(parcelId) };

          const parcel = await parcelsCollection.findOne(query);

          if (parcel && parcel.paymentStatus === "paid") {
            return res.send({
              success: true,
              message: "Payment already processed",
              trackingId: parcel.trackingId,
              transactionId: session.payment_intent,
            });
          }

          const trackingId = generateTrackingId();
          const update = {
            $set: { paymentStatus: "paid", trackingId: trackingId },
          };

          const result = await parcelsCollection.updateOne(query, update);

          const payment = {
            amount: session.amount_total / 100,
            currency: session.currency,
            customerEmail: session.customer_email,
            parcelId: parcelId,
            parcelName: session.metadata.parcelName,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          const resultPayment = await paymentCollection.insertOne(payment);

          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }

        res
          .status(400)
          .send({ success: false, message: "Payment not verified" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB successfully!");
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("zapShift API is running...");
});

// Port listener
app.listen(port, () => {
  console.log(`zapShift app listening on port ${port}`);
});

module.exports = app;
