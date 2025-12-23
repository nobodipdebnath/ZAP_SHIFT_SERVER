const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();

const stripe = require("stripe")(process.env.Payment_Key);
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);

const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tqpiihv.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();
    // console.log("MongoDB Connected");

    const db = client.db("ParcelDB");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    // Custom Middleware
    const verifyFireBaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden access: Admin only" });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "rider") {
        return res
          .status(403)
          .send({ message: "Forbidden access: Rider only" });
      }
      next();
    };

    // === User Routes ===
    app.get(
      "/users/search",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const emailQuery = req.query.email;
        if (!emailQuery) {
          return res.status(400).send({ message: "Missing email query" });
        }

        const regex = new RegExp(emailQuery, "i");

        try {
          const users = await userCollection
            .find({ email: { $regex: regex } })
            .limit(10)
            .toArray();
          res.send(users);
        } catch (error) {
          console.error("User search failed:", error);
          res.status(500).send({ message: "Failed to search users" });
        }
      }
    );

    app.post("/users", async (req, res) => {
      const { email } = req.body;

      const userExist = await userCollection.findOne({ email });
      if (userExist) {
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }

      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send({ ...result, inserted: true });
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const user = await userCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send({ role: user.role || "user" });
    });

    app.patch(
      "/users/:id/role",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;

        if (!["admin", "user", "rider"].includes(role)) {
          return res.status(400).send({ message: "Invalid role" });
        }

        try {
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
          res.send(result);
        } catch (error) {
          console.error("Role update failed:", error);
          res.status(500).send({ message: "Failed to update role" });
        }
      }
    );

    // === Rider Routes ===
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      try {
        const result = await ridersCollection.insertOne(rider);
        res.status(201).send(result);
      } catch (error) {
        console.error("Rider creation failed:", error);
        res.status(500).send({ message: "Failed to create rider" });
      }
    });

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;
      try {
        const query = { district };
        // Uncomment if you want to filter by status
        // query.status = { $in: ["approved", "active"] };

        const riders = await ridersCollection.find(query).toArray();
        res.send(riders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load available riders" });
      }
    });

    app.get(
      "/riders/pending",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const pendingRiders = await ridersCollection
            .find({ status: "pending" })
            .toArray();
          res.send(pendingRiders);
        } catch (error) {
          res.status(500).send({ message: "Failed to load pending riders" });
        }
      }
    );

    app.get(
      "/riders/active",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const activeRiders = await ridersCollection
            .find({ status: "active" })
            .toArray();
          res.send(activeRiders);
        } catch (error) {
          res.status(500).send({ message: "Failed to load active riders" });
        }
      }
    );

    app.patch(
      "/riders/:id/status",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status, email } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider ID" });
        }

        try {
          const result = await ridersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          if (status === "active" && email) {
            await userCollection.updateOne(
              { email },
              { $set: { role: "rider" } }
            );
          }

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update rider status" });
        }
      }
    );

    // === Tracking Routes ===
    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      try {
        const updates = await trackingsCollection
          .find({ tracking_id: trackingId })
          .sort({ timestamp: 1 })
          .toArray();

        res.json(updates);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch tracking updates" });
      }
    });

    app.post("/trackings", async (req, res) => {
      const update = req.body;

      if (!update.tracking_id || !update.status) {
        return res
          .status(400)
          .json({ message: "tracking_id and status are required." });
      }

      update.timestamp = new Date();

      try {
        const result = await trackingsCollection.insertOne(update);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add tracking update" });
      }
    });

    // === Parcel Routes ===
    app.get("/parcels", verifyFireBaseToken, async (req, res) => {
      try {
        const currentUserEmail = req.decoded.email;
        const isAdmin =
          (await userCollection.findOne({ email: currentUserEmail }))?.role ===
          "admin";

        let query = {};

        // Security: Regular users can only see their own parcels
        if (!isAdmin) {
          query.created_by = currentUserEmail;
        } else if (req.query.email) {
          query.created_by = req.query.email; // Admin can filter by user
        }

        if (req.query.payment_status)
          query.payment_status = req.query.payment_status;
        if (req.query.delivery_status)
          query.delivery_status = req.query.delivery_status;

        const options = { sort: { createdAt: -1 } };
        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to fetch parcels" });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        if (!ObjectId.isValid(req.params.id)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
      }
    });

    app.get("/parcels/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post("/parcels", verifyFireBaseToken, async (req, res) => {
      try {
        const newParcel = {
          ...req.body,
          created_by: req.decoded.email,
          createdAt: new Date(),
        };

        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send({
          message: "Parcel created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.delete("/parcels/:id", verifyFireBaseToken, async (req, res) => {
      try {
        if (!ObjectId.isValid(req.params.id)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send({ message: "Parcel deleted successfully" });
      } catch (error) {
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    app.patch(
      "/parcels/:id/assign",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const parcelId = req.params.id;
        const { riderId, riderName, riderEmail } = req.body;

        if (!ObjectId.isValid(parcelId) || !ObjectId.isValid(riderId)) {
          return res.status(400).send({ message: "Invalid ID" });
        }

        try {
          await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                delivery_status: "rider_assigned",
                assigned_rider_id: riderId,
                assigned_rider_email: riderEmail,
                assigned_rider_name: riderName,
              },
            }
          );

          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { work_status: "in_delivery" } }
          );

          res.send({ message: "Rider assigned successfully" });
        } catch (err) {
          console.error("Assign rider failed:", err);
          res.status(500).send({ message: "Failed to assign rider" });
        }
      }
    );

    app.patch(
      "/parcels/:id/status",
      verifyFireBaseToken,
      verifyRider,
      async (req, res) => {
        const parcelId = req.params.id;
        const { status } = req.body;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const updatedDoc = { delivery_status: status };

        if (status === "in_transit") {
          updatedDoc.picked_at = new Date();
        } else if (status === "delivered") {
          updatedDoc.delivered_at = new Date();
        }

        try {
          const result = await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            { $set: updatedDoc }
          );

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update parcel status" });
        }
      }
    );

    app.patch("/parcels/:id/cashout", verifyFireBaseToken, async (req, res) => {
      const id = req.params.id;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashed_out_at: new Date(),
            },
          }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to cash out" });
      }
    });

    // Rider-specific parcel routes
    app.get(
      "/rider/parcels",
      verifyFireBaseToken,
      verifyRider,
      async (req, res) => {
        const email = req.decoded.email;

        try {
          const query = {
            assigned_rider_email: email,
            delivery_status: { $in: ["rider_assigned", "in_transit"] },
          };

          const parcels = await parcelsCollection
            .find(query)
            .sort({ creation_date: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          res.status(500).send({ message: "Failed to load rider tasks" });
        }
      }
    );

    app.get(
      "/rider/completed-parcels",
      verifyFireBaseToken,
      verifyRider,
      async (req, res) => {
        const email = req.decoded.email;

        try {
          const query = {
            assigned_rider_email: email,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };

          const completedParcels = await parcelsCollection
            .find(query)
            .sort({ creation_date: -1 })
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to load completed deliveries" });
        }
      }
    );

    // === Payment Routes ===
    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents } = req.body;

      if (!amountInCents || amountInCents <= 0) {
        return res.status(400).json({ error: "Valid amount is required" });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/payments", verifyFireBaseToken, async (req, res) => {
      try {
        const currentUserEmail = req.decoded.email;
        const isAdmin =
          (await userCollection.findOne({ email: currentUserEmail }))?.role ===
          "admin";

        let query = {};
        if (!isAdmin) {
          query.email = currentUserEmail;
        } else if (req.query.email) {
          query.email = req.query.email;
        }

        const payments = await paymentCollection
          .find(query)
          .sort({ paid_at: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("Failed to fetch payments:", error);
        res.status(500).send({ message: "Failed to fetch payments" });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const { id, email, amount, paymentMethod, transactionId } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        const paymentDoc = {
          parcel_id: id,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at: new Date(),
          paid_at_string: new Date().toISOString(),
        };

        const paymentResult = await paymentCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded successfully",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment recording failed:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });
  } catch (err) {
    console.error("Database connection failed:", err);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Parcel Management Server is running");
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
