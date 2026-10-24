const config = {
  user: process.env.Database_User,
  password: process.env.Database_Password,
  server: process.env.Database_Server,
  //port: 3490,
  database: process.env.HCM_Database,
  driver: "tedious",
  options: {
    encrypt: true,
    trustServerCertificate: true,
    useUTC: true,
    requestTimeout: 120000,
  },
  pool: {
    max: 100,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};
module.exports = config;



// const dbName = process.env.LDS_Database;

// const config = process.env.DB_DRIVER === 'msnodesqlv8'
//   ? {
//     connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=${process.env.Database_Server};Database=${dbName};Trusted_Connection=yes;TrustServerCertificate=yes;`,
//     options: {
//       trustServerCertificate: true,
//       useUTC: true,
//       requestTimeout: 60000,
//     },
//   }
//   : {
//     user: process.env.Database_User,
//     password: process.env.Database_Password,
//     server: process.env.Database_Server,
//     port: parseInt(process.env.Database_port) || 1433,
//     database: dbName,
//     options: {
//       encrypt: true,
//       trustServerCertificate: true,
//       useUTC: true,
//       requestTimeout: 60000,
//     },
//   };

// module.exports = config;
