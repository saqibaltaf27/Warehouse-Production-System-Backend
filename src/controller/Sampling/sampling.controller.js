const { sql, poolPromise } = require('../../database/connection');

exports.getQCRmList = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status === 'Closed' ? 'C' : 'O'; // Default Open
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    request.input('status', sql.Char, status);

    const baseQuery = `
      FROM LDS_LIVE.dbo.OPDN D
      INNER JOIN LDS_LIVE.dbo.PDN1 A ON A.DocEntry = D.DocEntry
      INNER JOIN LDS_LIVE.dbo.OITM B ON B.ItemCode = A.ItemCode
      LEFT JOIN LDS_LIVE.dbo.IBT1 BT ON BT.BaseType = 20 AND BT.BaseEntry = A.DocEntry AND BT.BaseLinNum = A.LineNum AND BT.ItemCode = A.ItemCode
      LEFT JOIN LDS_LIVE.dbo.SRI1 ST ON ST.BaseType = 20 AND ST.BaseEntry = A.DocEntry AND ST.BaseLinNum = A.LineNum AND ST.ItemCode = A.ItemCode
      LEFT JOIN LDS_LIVE.dbo.OSRI SR ON SR.ItemCode = ST.ItemCode AND SR.SysSerial = ST.SysSerial
      WHERE B.U_QCItem = 'Y' 
        AND B.U_cat1 = 'Raw Material' 
        AND D.CANCELED = 'N'
        AND D.DocStatus = @status
    `;

    const countQuery = `SELECT COUNT(*) as totalRecords ${baseQuery}`;
    const countResult = await request.query(countQuery);
    const totalRecords = countResult.recordset[0].totalRecords;

    const dataQuery = `
      SELECT
          D.DocNum                         AS GRN_No,
          D.DocDate                        AS GRN_Date,
          case when d.series = 93 then 'Local'
          when d.series = 94 then 'Internationl'
          end as GRN_Type,
          A.ItemCode                       AS Item_Code,
          A.Dscription                     AS Item_Description,
          A.Quantity                       AS GRN_Quantity,
          CASE
              WHEN B.ManBtchNum = 'Y' THEN 'Batch'
              WHEN B.ManSerNum  = 'Y' THEN 'Serial'
              ELSE 'Non Batch/Serial'
          END                              AS Management_Type,
          COALESCE(BT.BatchNum, SR.IntrSerial) AS Batch_Serial_Number,
          CASE
              WHEN B.ManBtchNum = 'Y' THEN BT.Quantity
              WHEN B.ManSerNum  = 'Y' THEN 1
              ELSE A.Quantity
          END                              AS Batch_Serial_Qty
      ${baseQuery}
      ORDER BY
          D.DocNum DESC,
          A.LineNum,
          Batch_Serial_Number
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    
    const dataResult = await request.query(dataQuery);
    
    res.status(200).json({
      success: true,
      data: dataResult.recordset,
      pagination: {
        total: totalRecords,
        page,
        limit,
        pages: Math.ceil(totalRecords / limit)
      }
    });
    
  } catch (error) {
    console.error("Error in getQCRmList:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOpenDocuments = async (req, res) => {
  try {
    const { docType, search, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    let tableName = '';
    let hasSupplier = true;
    
    switch (docType) {
      case 'Goods Receipt PO': tableName = 'OPDN'; break;
      case 'Receipt From Production': tableName = 'OIGN'; hasSupplier = false; break;
      case 'Sales Return': tableName = 'ORDN'; break;
      case 'A/R Credit Memo': tableName = 'ORIN'; break;
      default: return res.status(400).json({ success: false, message: 'Invalid docType' });
    }
    
    const pool = await poolPromise;
    const request = pool.request();
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    
    let searchCondition = '';
    if (search) {
      request.input('search', sql.NVarChar, `%${search}%`);
      if (hasSupplier) {
        searchCondition = `AND (CAST(DocNum AS VARCHAR(50)) LIKE @search OR CardCode LIKE @search OR CardName LIKE @search)`;
      } else {
        // Search by ItemCode or ItemName for Receipt from production via EXISTS subquery
        searchCondition = `AND (CAST(DocNum AS VARCHAR(50)) LIKE @search OR EXISTS (SELECT 1 FROM LDS_LIVE.dbo.IGN1 L WHERE L.DocEntry = LDS_LIVE.dbo.${tableName}.DocEntry AND (L.ItemCode LIKE @search OR L.Dscription LIKE @search)))`;
      }
    }
    
    const baseQuery = `FROM LDS_LIVE.dbo.${tableName} WHERE DocStatus = 'O' AND CANCELED = 'N' ${searchCondition}`;
    
    const countResult = await request.query(`SELECT COUNT(*) as total ${baseQuery}`);
    const total = countResult.recordset[0].total;
    
    const selectCols = hasSupplier 
      ? 'DocEntry, DocNum, CardCode, CardName, DocDate' 
      : `DocEntry, DocNum, 
         (SELECT TOP 1 ItemCode FROM LDS_LIVE.dbo.IGN1 WHERE DocEntry = LDS_LIVE.dbo.${tableName}.DocEntry) AS ItemCode, 
         (SELECT TOP 1 Dscription FROM LDS_LIVE.dbo.IGN1 WHERE DocEntry = LDS_LIVE.dbo.${tableName}.DocEntry) AS ItemName, 
         DocDate`;
    
    const dataQuery = `
      SELECT ${selectCols}
      ${baseQuery}
      ORDER BY DocNum DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    const dataResult = await request.query(dataQuery);
    
    res.json({
      success: true,
      data: {
        items: dataResult.recordset.map(r => ({
           id: r.DocEntry,
           DocEntry: r.DocEntry,
           DocNum: r.DocNum,
           CardCode: r.CardCode || r.ItemCode || '',
           CardName: r.CardName || r.ItemName || '',
           DocDate: r.DocDate
        })),
        total
      }
    });
  } catch (err) {
    console.error("Error in getOpenDocuments:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getDocumentDetails = async (req, res) => {
  try {
    const { docType, docEntry } = req.query;
    if (!docType || !docEntry) return res.status(400).json({ success: false, message: 'Missing docType or docEntry' });
    
    let headerTable = '';
    let lineTable = '';
    let hasSupplier = true;
    let baseTypeCondition = '';
    
    switch (docType) {
      case 'Goods Receipt PO': headerTable = 'OPDN'; lineTable = 'PDN1'; break;
      case 'Receipt From Production': headerTable = 'OIGN'; lineTable = 'IGN1'; hasSupplier = false; baseTypeCondition = 'AND T1.BaseType = 202'; break;
      case 'Sales Return': headerTable = 'ORDN'; lineTable = 'RDN1'; break;
      case 'A/R Credit Memo': headerTable = 'ORIN'; lineTable = 'RIN1'; break;
      default: return res.status(400).json({ success: false, message: 'Invalid docType' });
    }
    
    const pool = await poolPromise;
    const request = pool.request();
    request.input('docEntry', sql.Int, docEntry);
    
    const selectSupplier = hasSupplier ? 'T0.CardCode, T0.CardName' : 'NULL AS CardCode, NULL AS CardName';
    
    const headerResult = await request.query(`
      SELECT T0.DocEntry, T0.DocNum, ${selectSupplier}, T0.DocDate 
      FROM LDS_LIVE.dbo.${headerTable} T0 
      WHERE T0.DocEntry = @docEntry
    `);
    
    if (headerResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    
    const header = headerResult.recordset[0];
    
    const linesQuery = `
      SELECT 
        T1.LineNum AS BaseLine,
        T1.ItemCode,
        T1.Dscription AS ItemName,
        T1.UomCode AS UOM,
        T1.UomEntry,
        T1.WhsCode AS Warehouse,
        T1.Quantity AS ActualQty,
        CASE
            WHEN B.ManBtchNum = 'Y' THEN 'Batch Managed'
            WHEN B.ManSerNum  = 'Y' THEN 'Serial Managed'
            ELSE 'Non Batch/Serial'
        END AS ManagedBy,
        COALESCE(BT.BatchNum, SR.IntrSerial) AS BatchSerial,
        COALESCE(OIBT.ExpDate, SR.ExpDate) AS ExpiryDate,
        NULL AS ManufactureDate,
        CASE
            WHEN B.ManBtchNum = 'Y' THEN BT.Quantity
            WHEN B.ManSerNum  = 'Y' THEN 1
            ELSE T1.Quantity
        END AS BatchSerialQty,
        COALESCE(OIBT.SuppSerial, SR.SuppSerial) AS SupplierBatchSerial
      FROM LDS_LIVE.dbo.${lineTable} T1
      INNER JOIN LDS_LIVE.dbo.OITM B ON B.ItemCode = T1.ItemCode
      LEFT JOIN LDS_LIVE.dbo.IBT1 BT ON BT.BaseType = (
         CASE 
           WHEN '${headerTable}' = 'OPDN' THEN 20 
           WHEN '${headerTable}' = 'OIGN' THEN 59
           WHEN '${headerTable}' = 'ORDN' THEN 16
           WHEN '${headerTable}' = 'ORIN' THEN 14
         END
      ) AND BT.BaseEntry = T1.DocEntry AND BT.BaseLinNum = T1.LineNum AND BT.ItemCode = T1.ItemCode
      LEFT JOIN LDS_LIVE.dbo.OIBT OIBT ON OIBT.ItemCode = BT.ItemCode AND OIBT.BatchNum = BT.BatchNum AND OIBT.WhsCode = T1.WhsCode
      LEFT JOIN LDS_LIVE.dbo.SRI1 ST ON ST.BaseType = (
         CASE 
           WHEN '${headerTable}' = 'OPDN' THEN 20 
           WHEN '${headerTable}' = 'OIGN' THEN 59
           WHEN '${headerTable}' = 'ORDN' THEN 16
           WHEN '${headerTable}' = 'ORIN' THEN 14
         END
      ) AND ST.BaseEntry = T1.DocEntry AND ST.BaseLinNum = T1.LineNum AND ST.ItemCode = T1.ItemCode
      LEFT JOIN LDS_LIVE.dbo.OSRI SR ON SR.ItemCode = ST.ItemCode AND SR.SysSerial = ST.SysSerial AND SR.WhsCode = T1.WhsCode
      WHERE T1.DocEntry = @docEntry ${baseTypeCondition}
    `;
    
    const linesResult = await request.query(linesQuery);
    
    res.json({
      success: true,
      data: {
        header,
        lines: linesResult.recordset
      }
    });
  } catch (err) {
    console.error("Error in getDocumentDetails:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNextQcNumber = async (req, res) => {
  try {
    const { poolPromise } = require('../../database/connection');
    const pool = await poolPromise;
    const request = pool.request();
    
    // The table is [@XD_OSMP] in DOME database. We get the max Docnum.
    const result = await request.query(`
      SELECT ISNULL(MAX(CAST(Docnum AS INT)), 0) + 1 AS nextId 
      FROM DOME.dbo.[@XD_OSMP]
    `);
    const nextId = result.recordset[0].nextId;

    res.json({ success: true, nextId });
  } catch (err) {
    console.error("Error getting next QC number:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getSavedSamples = async (req, res) => {
  try {
    const { poolPromise, sql } = require('../../database/connection');
    const pool = await poolPromise;
    const request = pool.request();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    
    const countQuery = `SELECT COUNT(*) as total FROM DOME.dbo.[@XD_OSMP] a JOIN DOME.dbo.[@XD_SMP1] b ON a.docentry = b.docentry`;
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    const dataQuery = `
      Select 
        a.Docnum as [Sampling No],
        cast(a.U_SmpDate as date) as [Sampling Date],
        case when a.U_Type = 20 then 'Goods Receipt PO'
        when a.U_Type = 59 then 'Receipt From Production'
        when a.U_type = 16 then 'Sales Return'
        when a.U_Type = 14 then 'A/R Credit Memo'
        end as [Docnument Type],
        a.U_DocNum as [Document No],
        a.U_CardCode as [Supplier Code],
        a.U_Cardname as [Supplier Name],
        a.U_BPLId as [Branch],
        b.U_RequestNo as [QC Request Number],
        case when b.U_Collect = 'Y' then 'Collected Sample'
        else 'No Sample Collected'
        end as [Collect Sample Type],
        b.U_ItemCode as [ItemCode],
        b.U_ItemName as [ItemName],
        b.U_Uom as [UOM],
        b.U_WhsCode as [Warehouse],
        b.U_ActualQty as [Actual Qty],
        case when b.U_Manage = 'B' then 'Batch Managed'
        when b.U_Manage = 'S' then 'Serial Managed' end  as [Managed By],
        b.U_Batch as [Batch],
        b.U_BatchQty as [Batch Qty],
        b.U_ExpDate as [Expiry Date],
        b.U_SmpQty as [Sample Qty],
        case when b.U_status = 'A' then 'Accepted'
        when b.U_status = 'UI' then 'Under Inspection'
        when b.U_status = 'P' then 'Pending'
        when b.U_status = 'S' then 'Sampled'
        when b.U_status = 'R' then 'Rejected'
        when b.U_status = 'CA' then 'Conditionally Accepted'
        when b.U_status = 'CR' then 'Conditionally Rejected'
        when b.U_status = 'C' then 'Cancel'
        when b.U_status = 'C' then 'Cancel'
        end as [Status],
        b.U_InvWhs as [Inventory Transfer Warehouse],
        b.U_InvNo as [Inventory Transfer No],
        a.U_DocEntry as [Document Entry]
      from DOME.dbo.[@XD_OSMP] a
      join DOME.dbo.[@XD_SMP1] b on a.docentry = b.docentry
      ORDER BY a.Docnum DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    const dataResult = await request.query(dataQuery);
    
    res.json({
      success: true,
      data: dataResult.recordset,
      pagination: {
        total, page, limit, pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error in getSavedSamples:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getSavedSampleDetails = async (req, res) => {
  try {
    const { docnum } = req.params;
    const { poolPromise, sql } = require('../../database/connection');
    const pool = await poolPromise;
    const request = pool.request();
    request.input('docnum', sql.NVarChar, docnum);

    const headerResult = await request.query(`
      SELECT * FROM DOME.dbo.[@XD_OSMP] WHERE Docnum = @docnum
    `);
    
    if (headerResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Sample not found' });
    }
    
    const header = headerResult.recordset[0];
    request.input('docentry', sql.Int, header.DocEntry);
    
    const linesResult = await request.query(`
      SELECT * FROM DOME.dbo.[@XD_SMP1] WHERE DocEntry = @docentry
    `);
    
    res.json({
      success: true,
      data: {
        header,
        lines: linesResult.recordset
      }
    });
  } catch (err) {
    console.error("Error in getSavedSampleDetails:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.saveSample = async (req, res) => {
  try {
    const { header, lines } = req.body;
    const { poolPromise, sql } = require('../../database/connection');
    const pool = await poolPromise;
    
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    
    try {
      // 1. Get new DocEntry
      const entryRequest = new sql.Request(transaction);
      const entryRes = await entryRequest.query(`SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NewDocEntry FROM DOME.dbo.[@XD_OSMP]`);
      const newDocEntry = entryRes.recordset[0].NewDocEntry;
      
      const newDocNum = newDocEntry; // Usually DocNum and DocEntry are same for these custom tables
      
      // 2. Insert Header
      const headerRequest = new sql.Request(transaction);
      headerRequest.input('DocEntry', sql.Int, newDocEntry);
      headerRequest.input('DocNum', sql.Int, newDocNum);
      headerRequest.input('U_SmpDate', sql.Date, header.SamplingDate ? new Date(header.SamplingDate) : new Date());
      headerRequest.input('U_Type', sql.Int, header.DocumentType);
      headerRequest.input('U_DocNum', sql.NVarChar, header.DocumentNumber ? String(header.DocumentNumber) : null);
      headerRequest.input('U_DocEntry', sql.Int, header.DocumentEntry ? parseInt(header.DocumentEntry) : null);
      headerRequest.input('U_CardCode', sql.NVarChar, header.SupplierCode ? String(header.SupplierCode) : null);
      headerRequest.input('U_CardName', sql.NVarChar, header.SupplierName ? String(header.SupplierName) : null);
      headerRequest.input('U_BPLId', sql.Int, 1);
      headerRequest.input('U_SmpBy', sql.NVarChar, header.UserEmpId ? String(header.UserEmpId) : null);
      headerRequest.input('U_SmpByName', sql.NVarChar, header.UserFirstName ? String(header.UserFirstName) : null);

      await headerRequest.query(`
        INSERT INTO DOME.dbo.[@XD_OSMP] 
        (DocEntry, DocNum, U_SmpDate, U_Type, U_DocNum, U_DocEntry, U_CardCode, U_Cardname, U_BPLId, U_SmpBy, U_SmpByName)
        VALUES 
        (@DocEntry, @DocNum, @U_SmpDate, @U_Type, @U_DocNum, @U_DocEntry, @U_CardCode, @U_CardName, @U_BPLId, @U_SmpBy, @U_SmpByName)
      `);

      // 3. Insert Lines
      for (let i = 0; i < lines.length; i++) {
        const item = lines[i];
        const lineRequest = new sql.Request(transaction);

        lineRequest.input('DocEntry', sql.Int, newDocEntry);
        lineRequest.input('LineId', sql.Int, i + 1);
        lineRequest.input('U_RequestNo', sql.NVarChar, item.QCRequestNumber ? String(item.QCRequestNumber) : null);
        lineRequest.input('U_Collect', sql.NVarChar, item.CollectSample || 'N');
        lineRequest.input('U_ItemCode', sql.NVarChar, item.ItemCode ? String(item.ItemCode) : null);
        lineRequest.input('U_ItemName', sql.NVarChar, item.ItemName ? String(item.ItemName) : null);
        lineRequest.input('U_Uom', sql.NVarChar, item.UOM ? String(item.UOM) : null);
        lineRequest.input('U_UomEntry', sql.Int, item.UomEntry || null);
        lineRequest.input('U_WhsCode', sql.NVarChar, item.Warehouse || null);
        lineRequest.input('U_ActualQty', sql.Numeric(19, 6), item.ActualQty || 0);
        lineRequest.input('U_Manage', sql.NVarChar, item.ManagedBy || null);
        lineRequest.input('U_Batch', sql.NVarChar, item.BatchSerial || null);
        lineRequest.input('U_Supplier', sql.NVarChar, item.SupplierBatchSerial || null);
        lineRequest.input('U_BatchQty', sql.Numeric(19, 6), item.BatchSerialQty || 0);
        lineRequest.input('U_ExpDate', sql.Date, item.ExpiryDate ? new Date(item.ExpiryDate) : null);
        lineRequest.input('U_SmpQty', sql.Numeric(19, 6), item.SampleQty || 0);
        lineRequest.input('U_status', sql.NVarChar, item.Status || null);
        lineRequest.input('U_BaseLine', sql.Int, item.BaseLine || 0);

        await lineRequest.query(`
          INSERT INTO DOME.dbo.[@XD_SMP1]
          (DocEntry, LineId, U_RequestNo, U_Collect, U_ItemCode, U_ItemName, U_Uom, U_UomEntry, U_WhsCode, 
           U_ActualQty, U_Manage, U_Batch, U_Supplier, U_BatchQty, U_ExpDate, U_SmpQty, U_status, U_BaseLine)
          VALUES
          (@DocEntry, @LineId, @U_RequestNo, @U_Collect, @U_ItemCode, @U_ItemName, @U_Uom, @U_UomEntry, @U_WhsCode,
           @U_ActualQty, @U_Manage, @U_Batch, @U_Supplier, @U_BatchQty, @U_ExpDate, @U_SmpQty, @U_status, @U_BaseLine)
        `);
      }

      await transaction.commit();
      res.json({ success: true, message: 'Sample saved successfully', docEntry: newDocEntry });
    } catch (dbErr) {
      await transaction.rollback();
      throw dbErr;
    }
  } catch (err) {
    console.error("Error saving sample:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getFilteredSamples = async (req, res) => {
  try {
    const { docType, status } = req.query;
    
    if (!docType || !status) {
      return res.status(400).json({ success: false, message: "docType and status are required" });
    }
    
    const { poolPromise, sql } = require('../../database/connection');
    const pool = await poolPromise;
    const request = pool.request();
    request.input('docType', sql.Int, parseInt(docType));
    request.input('status', sql.NVarChar, status);

    const query = `
      Select a.Docnum as [Sampling No],
      cast(a.U_SmpDate as date) as [Sampling Date],
      case when a.U_Type = 20 then 'Goods Receipt PO'
      when a.U_Type = 59 then 'Receipt From Production'
      when a.U_type = 16 then 'Sales Return'
      when a.U_Type = 14 then 'A/R Credit Memo'
      end as [Docnument Type],
      a.U_DocEntry as [Document Entry],
      a.U_DocNum as [Document No],
      a.U_CardCode as [Supplier Code],
      a.U_Cardname as [Supplier Name],
      a.U_BPLId as [Branch],
      b.U_RequestNo as [QC Request Number],
      case when U_Collect = 'Y' then 'Collected Sample'
      else 'No Sample Collected'
      end as [Collect Sample Type],
      b.U_ItemCode as [ItemCode],
      b.U_ItemName as [ItemName],
      b.U_Uom as [UOM],
      b.U_WhsCode as [Warehouse],
      b.U_ActualQty as [Actual Qty],
      case when b.U_Manage = 'B' then 'Batch Managed'
      when b.U_Manage = 'S' then 'Serial Managed' end  as [Managed By],
      b.U_Batch as [Batch],
      b.U_BatchQty as [Batch Qty],
      b.U_ExpDate as [Expiry Date],
      b.U_SmpQty as [Sample Qty],
      case when b.U_status = 'A' then 'Accepted'
      when b.U_status = 'UI' then 'Under Inspection'
      when b.U_status = 'P' then 'Pending'
      when b.U_status = 'S' then 'Sampled'
      when b.U_status = 'R' then 'Rejected'
      when b.U_status = 'CA' then 'Conditionally Accepted'
      when b.U_status = 'CR' then 'Conditionally Rejected'
      when b.U_status = 'C' then 'Cancel'
      end as [Status],
      b.U_InvWhs as [Inventory Transfer Warehouse],
      b.U_InvNo as [Inventory Transfer No]
      from DOME.dbo.[@XD_OSMP] a
      join DOME.dbo.[@XD_SMP1] b on a.docentry = b.docentry
      where a.U_Type = @docType and b.U_status = @status
    `;

    const result = await request.query(query);
    
    res.json({
      success: true,
      data: result.recordset
    });
  } catch (err) {
    console.error("Error in getFilteredSamples:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
