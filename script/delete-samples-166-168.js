require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { sql, poolPromise } = require("../src/database/connection");

async function main() {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const check = await new sql.Request(transaction).query(`
      SELECT DocEntry, DocNum, CAST(U_SmpDate AS date) AS SamplingDate
      FROM DOME.dbo.[@XD_OSMP]
      WHERE DocNum IN (166, 168)
      ORDER BY DocNum
    `);

    console.log("Found before delete:", JSON.stringify(check.recordset, null, 2));

    if (check.recordset.length === 0) {
      throw new Error("No rows found for Sampling No 166 or 168");
    }

    const lines = await new sql.Request(transaction).query(`
      DELETE FROM DOME.dbo.[@XD_SMP1]
      WHERE DocEntry IN (
        SELECT DocEntry FROM DOME.dbo.[@XD_OSMP] WHERE DocNum IN (166, 168)
      );
      SELECT @@ROWCOUNT AS deletedLines;
    `);

    const headers = await new sql.Request(transaction).query(`
      DELETE FROM DOME.dbo.[@XD_OSMP]
      WHERE DocNum IN (166, 168);
      SELECT @@ROWCOUNT AS deletedHeaders;
    `);

    await transaction.commit();

    console.log(
      JSON.stringify(
        {
          deletedLines: lines.recordset?.[0]?.deletedLines ?? lines.rowsAffected,
          deletedHeaders: headers.recordset?.[0]?.deletedHeaders ?? headers.rowsAffected,
        },
        null,
        2
      )
    );

    const verify = await pool.request().query(`
      SELECT DocNum FROM DOME.dbo.[@XD_OSMP] WHERE DocNum IN (166, 168)
    `);
    console.log("Remaining 166/168:", verify.recordset);
  } catch (err) {
    await transaction.rollback();
    throw err;
  } finally {
    await sql.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
