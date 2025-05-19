const Pool = require("pg").Pool;
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  // host: process.env.HOST,
  // port: process.env.PORT,
  // user: process.env.USER,
  // password: process.env.PASSWORD,
  // database: process.env.DATABASE
  // noty working
  // host: "testing-team-postgres.caprover.mtechub.org",
  // port: 5432,
  // user: "rimshariaz@mtechub.org",
  // password: "Mtechub@123",
  // // database: "cueballs",
  // // database: "cueball-phase2-staging",
  // database: "numee_staging",

  // max: 10,
  host: "postgres-staging-projects.mtechub.com",
  port: 5432,
  user: "lone_user",
  password: "mtechub123",
  database: "staging-numee",
  max: 10,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

// Improved database initialization with table checking and better error handling
const initializeDatabase = async () => {
  let client;
  try {
    // Get a client from the pool
    client = await pool.connect();

    // First check if our tables already exist
    const checkTableQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'device_tokens', 'twilio_number_mapping', 'call_logs');
    `;

    const tablesResult = await client.query(checkTableQuery);
    const existingTables = tablesResult.rows.map((row) => row.table_name);

    console.log(
      `Found ${existingTables.length} existing tables:`,
      existingTables
    );

    // Read and execute the initialization SQL
    const sqlFilePath = path.join(__dirname, "../../app/models/init.sql");
    console.log(`Reading initialization SQL from: ${sqlFilePath}`);

    if (!fs.existsSync(sqlFilePath)) {
      throw new Error(`SQL file not found at path: ${sqlFilePath}`);
    }

    const initSql = fs.readFileSync(sqlFilePath, "utf8");

    // Execute the SQL initialization script
    console.log("Initializing database tables...");
    await client.query(initSql);

    console.log("Database tables initialized successfully.");

    // Verify tables after initialization
    const verifyTablesResult = await client.query(checkTableQuery);
    const tablesAfterInit = verifyTablesResult.rows.map(
      (row) => row.table_name
    );
    console.log(
      `Tables after initialization: ${tablesAfterInit.length}`,
      tablesAfterInit
    );
  } catch (err) {
    console.error("Error initializing database:", err);
    process.exit(1); // Exit if database initialization fails
  } finally {
    if (client) {
      client.release();
    }
  }
};

// Connect to database and initialize tables
pool.connect((err, client, release) => {
  if (err) {
    console.error("Error connecting to database:", err);
    process.exit(1); // Exit if unable to connect to database
  } else {
    console.log("Connected to database successfully");
    release();

    // Initialize database after successful connection
    initializeDatabase().catch((err) => {
      console.error("Failed to initialize database:", err);
      process.exit(1);
    });
  }
});

module.exports = pool;
