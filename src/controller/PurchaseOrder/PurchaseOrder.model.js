const { sql, poolPromise } = require("../../database/connection");

class PurchaseOrderModel {
    static async getPurchaseRequests(limit, offset, search = '') {
        try {
            const pool = await poolPromise;
            
            let whereClause = '';
            if (search) {
                whereClause = ` WHERE 
                    CAST(T0.DocEntry AS VARCHAR) LIKE '%' + @search + '%' OR 
                    CAST(T0.DocNum AS VARCHAR) LIKE '%' + @search + '%' OR 
                    T0.ReqName LIKE '%' + @search + '%' `;
            }

            const countQuery = `SELECT COUNT(*) as total FROM LDS_LIVE.dbo.OPRQ T0 ${whereClause}`;
            const countReq = pool.request();
            if (search) countReq.input('search', sql.VarChar, search);
            const countResult = await countReq.query(countQuery);
            const total = countResult.recordset[0].total;

            let query = `
                SELECT 
                    T0.DocEntry, 
                    T0.DocNum, 
                    CASE WHEN T0.DocStatus = 'O' THEN 'Open' WHEN T0.DocStatus = 'C' THEN 'Closed' ELSE T0.DocStatus END AS DocStatus, 
                    T0.DocDate, 
                    T0.ReqDate, 
                    T0.Requester, 
                    T0.ReqName, 
                    T1.Remarks AS Branch, 
                    T0.Comments 
                FROM LDS_LIVE.dbo.OPRQ T0
                LEFT JOIN LDS_LIVE.dbo.OUBR T1 ON T0.Branch = T1.Code
                ${whereClause}
                ORDER BY T0.DocEntry DESC
            `;

            if (limit > 0) {
                query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
            }

            const req = pool.request();
            if (search) req.input('search', sql.VarChar, search);
            if (limit > 0) {
                req.input('offset', sql.Int, offset);
                req.input('limit', sql.Int, limit);
            }

            const result = await req.query(query);
            return {
                data: result.recordset,
                total: total
            };
        } catch (error) {
            throw error;
        }
    }

    static async getPurchaseRequestDetails(docEntry) {
        try {
            const pool = await poolPromise;
            
            // Header Query
            const headerResult = await pool.request()
                .input('docEntry', sql.Int, docEntry)
                .query(`
                    SELECT T0.*, T1.Remarks AS BranchName
                    FROM LDS_LIVE.dbo.OPRQ T0
                    LEFT JOIN LDS_LIVE.dbo.OUBR T1 ON T0.Branch = T1.Code
                    WHERE T0.DocEntry = @docEntry;
                `);

            // Line Items Query
            const linesResult = await pool.request()
                .input('docEntry', sql.Int, docEntry)
                .query(`
                    SELECT T0.*, T1.CardName AS VendorName, T2.WhsName AS WarehouseName
                    FROM LDS_LIVE.dbo.PRQ1 T0
                    LEFT JOIN LDS_LIVE.dbo.OCRD T1 ON T0.LineVendor = T1.CardCode
                    LEFT JOIN LDS_LIVE.dbo.OWHS T2 ON T0.WhsCode = T2.WhsCode
                    WHERE T0.DocEntry = @docEntry 
                    ORDER BY T0.LineNum ASC;
                `);

            return {
                header: headerResult.recordset[0] || null,
                lines: linesResult.recordset || []
            };
        } catch (error) {
            throw error;
        }
    }
}

module.exports = PurchaseOrderModel;
