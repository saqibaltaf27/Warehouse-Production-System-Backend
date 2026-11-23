const sql = require("mssql");
const config = require("./config");

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("✅ Connected to SQL Server");
    return pool;
  })
  .catch((err) => {
    console.error("❌ Database Connection Failed:", err);
    throw new Error("Database Connection Failed");
  });

module.exports = { sql, poolPromise };


// const driver = process.env.DB_DRIVER === 'msnodesqlv8' ? 'mssql/msnodesqlv8' : 'mssql';
// const sql = require(driver);
// if (process.env.DB_DRIVER === 'msnodesqlv8') {
//   const mssqlPath = require.resolve('mssql');
//   require.cache[mssqlPath] = {
//     id: mssqlPath,
//     filename: mssqlPath,
//     loaded: true,
//     exports: sql
//   };
// }

// const config = require("./config");

// const poolPromise = sql.connect(config)
//   .then((pool) => {
//     console.log(`✅ Connected to SQL Server (${process.env.DB_DRIVER})`);
//     return pool;
//   })
//   .catch((err) => {
//     console.error("❌ Database Connection Failed:", err);
//     throw new Error("Database Connection Failed");
//   });

// module.exports = { sql, poolPromise };
