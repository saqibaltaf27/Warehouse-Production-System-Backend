const { sql, poolPromise } = require("../../database/connection");

class PurchaseOrderModel {
    static async getPurchaseRequests(limit, offset, search = '', status = '', branch = '', fromDate = '', toDate = '') {
        try {
            const pool = await poolPromise;
            
            const conditions = [];
            const req = pool.request();
            const countReq = pool.request();

            if (search) {
                conditions.push(`(CAST(T0.DocEntry AS VARCHAR) LIKE '%' + @search + '%' OR CAST(T0.DocNum AS VARCHAR) LIKE '%' + @search + '%' OR T0.ReqName LIKE '%' + @search + '%' OR T0.Comments LIKE '%' + @search + '%')`);
                req.input('search', sql.VarChar, search);
                countReq.input('search', sql.VarChar, search);
            }

            if (status) {
                if (status === 'Open' || status === 'O') {
                    conditions.push(`(T0.DocStatus = 'O' OR T0.DocStatus = 'Open')`);
                } else if (status === 'Closed' || status === 'C') {
                    conditions.push(`(T0.DocStatus = 'C' OR T0.DocStatus = 'Closed')`);
                } else {
                    conditions.push(`T0.DocStatus = @status`);
                    req.input('status', sql.VarChar, status);
                    countReq.input('status', sql.VarChar, status);
                }
            }

            if (branch) {
                conditions.push(`(T1.Remarks = @branch OR CAST(T0.Branch AS VARCHAR) = @branch)`);
                req.input('branch', sql.VarChar, branch);
                countReq.input('branch', sql.VarChar, branch);
            }

            if (fromDate) {
                conditions.push(`T0.DocDate >= @fromDate`);
                req.input('fromDate', sql.VarChar, fromDate);
                countReq.input('fromDate', sql.VarChar, fromDate);
            }

            if (toDate) {
                conditions.push(`T0.DocDate <= @toDate`);
                req.input('toDate', sql.VarChar, toDate);
                countReq.input('toDate', sql.VarChar, toDate);
            }

            const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')} ` : '';

            const countQuery = `SELECT COUNT(*) as total FROM LDS_LIVE.dbo.OPRQ T0 LEFT JOIN LDS_LIVE.dbo.OUBR T1 ON T0.Branch = T1.Code ${whereClause}`;
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
