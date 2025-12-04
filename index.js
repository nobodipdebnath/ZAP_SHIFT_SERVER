const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const stripe = require("stripe")(process.env.Payment_Key);
const app = express();
const port = process.env.PORT || 3000;

// MiddleWare
app.use(cors());
app.use(express.json());

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
    await client.connect();
    console.log("MongoDB Connected");

    const db = client.db("ParcelDB");
    const parcelCollection = db.collection("parcels");

    // GET all parcels
    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    // parcel api
    // Get: all parcel of parcels by user (created by), sorted by latest

    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};

        const options = {
          sort: { createdAt: -1 },
        };
        const parcels = await parcelCollection.find(query.options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error Fetching Parcel:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // one parcel found
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return;
        }
        res.send(parcel);
      } catch (error) {
        console.error("Error Inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // POST a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);

        res.status(201).send({
          message: "Parcel created successfully",
          data: result,
        });
      } catch (error) {
        console.error("Error Inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // Delete
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Parcel Id" });
        }

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }
        res.send(result);
      } catch (error) {
        console.error("Error Deleting parcel: ", error);
        res.status(500).send({ message: "failed to delete parcel" });
      }
    });

    // Payment

    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents } = req.body;

      if (!amountInCents) {
        return res.status(400).json({ error: "Amount is required" });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.status(200).json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Parcel Server is running");
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
