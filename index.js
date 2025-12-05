const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();

const stripe = require("stripe")(process.env.Payment_Key);
const app = express();
const port = process.env.PORT || 3000;

// MiddleWare
app.use(cors());
app.use(express.json());



const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
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
    await client.connect();
    console.log("MongoDB Connected");

    const db = client.db("ParcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection('payments');
    const userCollection = db.collection('users');

    // Custom middleWare
    const verifyFireBaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if(!authHeader){
        return res.status(401).send({message: 'unauthorized access'})
      }

      const token = authHeader.split(' ')[1];
      if(!token){
        return res.status(401).send({message: 'unauthorized access'})
      }

      // verify the token
      try{
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      }catch(error){
        return res.status(403).send({message: 'forbidden access'});
      }
    }


    app.post('/users', async (req, res) => {
      const email = req.body.email;
      
      const userExist = await userCollection.findOne({email});
      if(userExist){
        return res.status(200).send({message: 'User already exists', inserted: false})
      }
      const user = req.body;
      const result =await userCollection.insertOne(user);
      res.send(result);
    })

    // parcel api
    // Get: all parcel of parcels by user (created by), sorted by latest

    app.get("/parcels", verifyFireBaseToken, async (req, res) => {
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

    // track parcel 

    // app.post('/tracking', async (req, res) => {
    //   const {tracking_id, id, status, message, update_by=''} = req.body;

    //   const log ={
    //     tracking_id,
    //     id: id? new ObjectId(id): undefined,
    //     status,
    //     message,
    //     update_by,
    //     time: new Date(),
    //   };

    //   const result = await trackingCollection.insertOne(log);
    //   res.send(result)
    // })

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

    // Payment get
    app.get('/payments', verifyFireBaseToken, async (req, res) => {
      try{
        const userEmail = req.query.email;
        const query = userEmail? {email : userEmail}: {};
        const options = {sort: {paid_at: -1}};

        const payments = await paymentCollection.find(query, options).toArray();
        res.send(payments);
      } catch(error){
        console.error('Payment get failed', error);
        res.status(500).json({error: error.message})
      }
    })

    // record payment and update parcel status
    app.post('/payments', async (req, res) => {
      try{
        const {id, email, amount, paymentMethod, transactionId} = req.body;

        const updateResult = await parcelCollection.updateOne(
          {_id: new ObjectId(id)},
          {
            $set: {
              payment_status: 'paid'
            }
          }
        );

        if(updateResult.modifiedCount === 0){
          return res.status(404).send({message: 'parcel not found or already paid'});
        }

        const paymentDoc = {
          id,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date()
        }

        const paymentResult = await paymentCollection.insertOne(paymentDoc);

        res.status(200).send({
          message: 'Payment recorded and parcel marked as paid',
          insertedId: paymentResult.insertedId,
        })

      } catch(error){
        console.error('Payment post failed', error);
        res.status(500).json({error: error.message});
      }
    })

    
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
