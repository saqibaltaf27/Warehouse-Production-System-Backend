require('./src/database/connection.js').poolPromise.then(pool => 
  pool.request().query("SELECT COLUMN_NAME, DATA_TYPE FROM Dome.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'PMSComplaints'")
  .then(res => { 
    console.log(JSON.stringify(res.recordset, null, 2)); 
    process.exit(0); 
  })
).catch(err => {
  console.error(err);
  process.exit(1);
});
