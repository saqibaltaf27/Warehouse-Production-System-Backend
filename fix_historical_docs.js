require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');

async function run() {
    try {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 1. Goods Receipt PO (Type 20) - table OPDN
            let r1 = await transaction.request().query(`
                UPDATE H
                SET 
                    H.U_DocEntry = O.DocEntry,
                    H.U_DocNum = CAST(O.DocNum AS VARCHAR(50))
                FROM [DOME].[dbo].[@XD_OSMP] H
                JOIN LDS_LIVE.dbo.OPDN O ON O.DocEntry = CAST(H.U_DocNum AS INT)
                WHERE H.U_Type = '20' 
                  AND (H.U_DocEntry IS NULL OR H.U_DocEntry = H.U_DocNum)
                  AND ISNUMERIC(H.U_DocNum) = 1
            `);
            console.log("Goods Receipt PO updated:", r1.rowsAffected);

            // 2. Receipt From Production (Type 59) - table OIGN
            let r2 = await transaction.request().query(`
                UPDATE H
                SET 
                    H.U_DocEntry = O.DocEntry,
                    H.U_DocNum = CAST(O.DocNum AS VARCHAR(50))
                FROM [DOME].[dbo].[@XD_OSMP] H
                JOIN LDS_LIVE.dbo.OIGN O ON O.DocEntry = CAST(H.U_DocNum AS INT)
                WHERE H.U_Type = '59' 
                  AND (H.U_DocEntry IS NULL OR H.U_DocEntry = H.U_DocNum)
                  AND ISNUMERIC(H.U_DocNum) = 1
            `);
            console.log("Receipt From Production updated:", r2.rowsAffected);

            // 3. Sales Return (Type 16) - table ORDN
            let r3 = await transaction.request().query(`
                UPDATE H
                SET 
                    H.U_DocEntry = O.DocEntry,
                    H.U_DocNum = CAST(O.DocNum AS VARCHAR(50))
                FROM [DOME].[dbo].[@XD_OSMP] H
                JOIN LDS_LIVE.dbo.ORDN O ON O.DocEntry = CAST(H.U_DocNum AS INT)
                WHERE H.U_Type = '16' 
                  AND (H.U_DocEntry IS NULL OR H.U_DocEntry = H.U_DocNum)
                  AND ISNUMERIC(H.U_DocNum) = 1
            `);
            console.log("Sales Return updated:", r3.rowsAffected);

            // 4. A/R Credit Memo (Type 14) - table ORIN
            let r4 = await transaction.request().query(`
                UPDATE H
                SET 
                    H.U_DocEntry = O.DocEntry,
                    H.U_DocNum = CAST(O.DocNum AS VARCHAR(50))
                FROM [DOME].[dbo].[@XD_OSMP] H
                JOIN LDS_LIVE.dbo.ORIN O ON O.DocEntry = CAST(H.U_DocNum AS INT)
                WHERE H.U_Type = '14' 
                  AND (H.U_DocEntry IS NULL OR H.U_DocEntry = H.U_DocNum)
                  AND ISNUMERIC(H.U_DocNum) = 1
            `);
            console.log("A/R Credit Memo updated:", r4.rowsAffected);

            // Also fix row 129 where U_DocNum is 200660 and U_DocEntry is NULL
            let r5 = await transaction.request().query(`
                UPDATE H
                SET 
                    H.U_DocEntry = O.DocEntry
                FROM [DOME].[dbo].[@XD_OSMP] H
                JOIN LDS_LIVE.dbo.OPDN O ON O.DocNum = CAST(H.U_DocNum AS INT)
                WHERE H.U_Type = '20' 
                  AND H.U_DocEntry IS NULL 
                  AND ISNUMERIC(H.U_DocNum) = 1
            `);
            console.log("Fixed missing DocEntries by DocNum lookup:", r5.rowsAffected);

            await transaction.commit();
            console.log("Successfully fixed all old records.");
        } catch (err) {
            console.error("Error during update:", err);
            await transaction.rollback();
        }
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
