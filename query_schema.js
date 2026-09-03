const sql = require('mssql/msnodesqlv8');

const config = {
  connectionString: 'Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=dome;Trusted_Connection=yes;TrustServerCertificate=yes;',
  options: {
    trustServerCertificate: true,
    useUTC: true,
    requestTimeout: 60000,
  },
};

async function run() {
  try {
    const pool = await sql.connect(config);
    
    console.log("=== pmsinstrument ===");
    const res1 = await pool.request().query("SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'pmsinstrument'");
    console.table(res1.recordset);
    
    console.log("\n=== pmspreventivemaintenance ===");
    const res2 = await pool.request().query("SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'pmspreventivemaintenance'");
    console.table(res2.recordset);
    
    await pool.close();
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
