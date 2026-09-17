require('dotenv').config(); 
const { poolPromise } = require('./src/database/connection'); 
const query = `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PMSCOATemplate' and xtype='U') CREATE TABLE Dome.dbo.PMSCOATemplate ( ItemCode NVARCHAR(50) PRIMARY KEY, Description NVARCHAR(MAX), CreatedBy INT NOT NULL, CreatedDate DATETIME DEFAULT GETDATE() );`; 
poolPromise.then(pool => pool.request().query(query)).then(() => { console.log('Table created or already exists'); process.exit(0); }).catch(err => { console.error('Error:', err); process.exit(1); });
