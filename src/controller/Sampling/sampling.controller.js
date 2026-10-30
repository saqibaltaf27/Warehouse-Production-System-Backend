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
      LEFT JOIN (
          SELECT BaseType, BaseEntry, BaseLinNum, ItemCode, BatchNum, SUM(Quantity) AS Quantity
          FROM LDS_LIVE.dbo.IBT1
          GROUP BY BaseType, BaseEntry, BaseLinNum, ItemCode, BatchNum
      ) BT ON BT.BaseType = 20 AND BT.BaseEntry = A.DocEntry AND BT.BaseLinNum = A.LineNum AND BT.ItemCode = A.ItemCode
      LEFT JOIN (
          SELECT BaseType, BaseEntry, BaseLinNum, ItemCode, SysSerial
          FROM LDS_LIVE.dbo.SRI1
          GROUP BY BaseType, BaseEntry, BaseLinNum, ItemCode, SysSerial
      ) ST ON ST.BaseType = 20 AND ST.BaseEntry = A.DocEntry AND ST.BaseLinNum = A.LineNum AND ST.ItemCode = A.ItemCode
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
    let lineTable = '';
    let hasSupplier = true;
    let uType = 0;
    
    switch (docType) {
      case 'Goods Receipt PO': tableName = 'OPDN'; lineTable = 'PDN1'; uType = 20; break;
      case 'Receipt From Production': tableName = 'OIGN'; lineTable = 'IGN1'; hasSupplier = false; uType = 59; break;
      case 'Sales Return': tableName = 'ORDN'; lineTable = 'RDN1'; uType = 16; break;
      case 'A/R Credit Memo': tableName = 'ORIN'; lineTable = 'RIN1'; uType = 14; break;
      default: return res.status(400).json({ success: false, message: 'Invalid docType' });
    }
    
    const pool = await poolPromise;
    const request = pool.request();
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    request.input('uType', sql.Int, uType);
    
    let searchCondition = '';
    if (search) {
      request.input('search', sql.NVarChar, `%${search}%`);
      if (hasSupplier) {
        searchCondition = `AND (CAST(T.DocNum AS VARCHAR(50)) LIKE @search OR T.CardCode LIKE @search OR T.CardName LIKE @search)`;
      } else {
        searchCondition = `AND (CAST(T.DocNum AS VARCHAR(50)) LIKE @search OR EXISTS (SELECT 1 FROM LDS_LIVE.dbo.IGN1 L WHERE L.DocEntry = T.DocEntry AND (L.ItemCode LIKE @search OR L.Dscription LIKE @search)))`;
      }
    }

    // Hide documents that already have a sample, unless every sample line was cancelled.
    const notSampledCondition = `
      AND NOT EXISTS (
        SELECT 1
        FROM DOME.dbo.[@XD_OSMP] S
        WHERE S.U_Type = @uType
          AND S.U_DocEntry = T.DocEntry
          AND (
            NOT EXISTS (SELECT 1 FROM DOME.dbo.[@XD_SMP1] L WHERE L.DocEntry = S.DocEntry)
            OR EXISTS (
              SELECT 1 FROM DOME.dbo.[@XD_SMP1] L
              WHERE L.DocEntry = S.DocEntry AND ISNULL(L.U_status, '') <> 'C'
            )
          )
      )`;

    const isGoodsReceipt = docType === 'Goods Receipt PO';
    const qcItemCondition = isGoodsReceipt ? `
      AND EXISTS (
        SELECT 1
        FROM LDS_LIVE.dbo.${lineTable} L
        INNER JOIN LDS_LIVE.dbo.OITM B ON B.ItemCode = L.ItemCode
        WHERE L.DocEntry = T.DocEntry
          AND ISNULL(B.U_QCItem, '') = 'Y'
      )` : '';
    
    const baseQuery = `FROM LDS_LIVE.dbo.${tableName} T WHERE T.DocStatus = 'O' AND T.CANCELED = 'N' ${qcItemCondition} ${notSampledCondition} ${searchCondition}`;
    
    const countResult = await request.query(`SELECT COUNT(*) as total ${baseQuery}`);
    const total = countResult.recordset[0].total;
    
    const itemCountSql = isGoodsReceipt
      ? `(SELECT COUNT(DISTINCT L.ItemCode) FROM LDS_LIVE.dbo.${lineTable} L INNER JOIN LDS_LIVE.dbo.OITM B ON B.ItemCode = L.ItemCode WHERE L.DocEntry = T.DocEntry AND ISNULL(B.U_QCItem, '') = 'Y') AS ItemCount`
      : `(SELECT COUNT(DISTINCT L.ItemCode) FROM LDS_LIVE.dbo.${lineTable} L WHERE L.DocEntry = T.DocEntry) AS ItemCount`;
    const selectCols = hasSupplier 
      ? `T.DocEntry, T.DocNum, T.CardCode, T.CardName, T.DocDate, ${itemCountSql}` 
      : `T.DocEntry, T.DocNum, 
         (SELECT TOP 1 ItemCode FROM LDS_LIVE.dbo.IGN1 WHERE DocEntry = T.DocEntry) AS ItemCode, 
         (SELECT TOP 1 Dscription FROM LDS_LIVE.dbo.IGN1 WHERE DocEntry = T.DocEntry) AS ItemName, 
         T.DocDate, ${itemCountSql}`;
    
    const dataQuery = `
      SELECT ${selectCols}
      ${baseQuery}
      ORDER BY T.DocDate DESC, T.DocNum DESC
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
           DocDate: r.DocDate,
           ItemCount: r.ItemCount || 0
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
    
    const sapBaseType = { OPDN: 20, OIGN: 59, ORDN: 16, ORIN: 14 }[headerTable];
    const pool = await poolPromise;
    const request = pool.request();
    request.input('docEntry', sql.Int, docEntry);
    request.input('baseType', sql.Int, sapBaseType);

    const qcFilter = headerTable === 'OPDN' ? "AND ISNULL(B.U_QCItem, '') = 'Y'" : '';
    const preview = String(req.query.preview || '') === '1';

    if (preview) {
      const previewResult = await request.query(`
        SELECT
          T1.LineNum AS BaseLine,
          T1.ItemCode,
          T1.Dscription AS ItemName,
          T1.Quantity AS ActualQty
        FROM LDS_LIVE.dbo.${lineTable} T1 WITH (NOLOCK)
        INNER JOIN LDS_LIVE.dbo.OITM B WITH (NOLOCK) ON B.ItemCode = T1.ItemCode
        WHERE T1.DocEntry = @docEntry
          ${qcFilter}
          ${baseTypeCondition}
      `);
      return res.json({
        success: true,
        data: { header: null, lines: previewResult.recordset || [] },
      });
    }
    
    const selectSupplier = hasSupplier ? 'T0.CardCode, T0.CardName' : 'NULL AS CardCode, NULL AS CardName';
    
    const headerResult = await request.query(`
      SELECT T0.DocEntry, T0.DocNum, ${selectSupplier}, T0.DocDate 
      FROM LDS_LIVE.dbo.${headerTable} T0 WITH (NOLOCK)
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
        COALESCE(BT.ExpDate, SR.ExpDate) AS ExpiryDate,
        NULL AS ManufactureDate,
        CASE
            WHEN B.ManBtchNum = 'Y' THEN BT.Quantity
            WHEN B.ManSerNum  = 'Y' THEN 1
            ELSE T1.Quantity
        END AS BatchSerialQty,
        COALESCE(BT.SuppSerial, SR.SuppSerial) AS SupplierBatchSerial
      FROM LDS_LIVE.dbo.${lineTable} T1 WITH (NOLOCK)
      INNER JOIN LDS_LIVE.dbo.OITM B WITH (NOLOCK) ON B.ItemCode = T1.ItemCode
      OUTER APPLY (
          SELECT TOP 1
            X.BatchNum,
            X.Quantity,
            O.ExpDate,
            O.SuppSerial
          FROM LDS_LIVE.dbo.IBT1 X WITH (NOLOCK)
          LEFT JOIN LDS_LIVE.dbo.OIBT O WITH (NOLOCK)
            ON O.ItemCode = X.ItemCode AND O.BatchNum = X.BatchNum AND O.WhsCode = T1.WhsCode
          WHERE X.BaseType = @baseType
            AND X.BaseEntry = @docEntry
            AND X.BaseLinNum = T1.LineNum
            AND X.ItemCode = T1.ItemCode
        ) BT
      OUTER APPLY (
          SELECT TOP 1
            R.IntrSerial,
            R.ExpDate,
            R.SuppSerial
          FROM LDS_LIVE.dbo.SRI1 S WITH (NOLOCK)
          INNER JOIN LDS_LIVE.dbo.OSRI R WITH (NOLOCK)
            ON R.ItemCode = S.ItemCode AND R.SysSerial = S.SysSerial AND R.WhsCode = T1.WhsCode
          WHERE S.BaseType = @baseType
            AND S.BaseEntry = @docEntry
            AND S.BaseLinNum = T1.LineNum
            AND S.ItemCode = T1.ItemCode
        ) SR
      WHERE T1.DocEntry = @docEntry
        ${qcFilter}
        ${baseTypeCondition}
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
    
    let joinClause = '';
    let whereClause = '';
    let extraSelect = '';
    
    const conditions = [];
    const allowedStatuses = ['A', 'UI', 'P', 'S', 'R', 'CA', 'CR', 'C'];

    if (req.query.status) {
       joinClause = `JOIN DOME.dbo.[@XD_SMP1] b ON a.docentry = b.docentry`;
       const statuses = req.query.status.split(',').map(s => s.trim()).filter(s => allowedStatuses.includes(s));
       if (statuses.length) {
         conditions.push(`b.U_status IN (${statuses.map(s => `'${s}'`).join(',')})`);
       }
       extraSelect = `, b.U_ItemName as [Item Name], b.U_Batch as [Batch]`;
    }

    const search = String(req.query.search || '').trim();
    if (search) {
       request.input('search', sql.NVarChar, `%${search}%`);
       conditions.push(`(
         CAST(a.Docnum AS nvarchar(50)) LIKE @search
         OR a.U_CardCode LIKE @search
         OR a.U_Cardname LIKE @search
       )`);
    }

    if (req.query.docType) {
       request.input('docType', sql.Int, parseInt(req.query.docType, 10));
       conditions.push('a.U_Type = @docType');
    }

    if (req.query.fromDate) {
       request.input('fromDate', sql.Date, req.query.fromDate);
       conditions.push('CAST(a.U_SmpDate AS date) >= @fromDate');
    }

    if (req.query.toDate) {
       request.input('toDate', sql.Date, req.query.toDate);
       conditions.push('CAST(a.U_SmpDate AS date) <= @toDate');
    }

    if (req.query.currentMonth === 'true' && !req.query.fromDate && !req.query.toDate) {
       conditions.push(`a.U_SmpDate >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)`);
       conditions.push(`a.U_SmpDate < DATEADD(month, DATEDIFF(month, 0, GETDATE()) + 1, 0)`);
    }

    if (conditions.length) {
       whereClause = `WHERE ${conditions.join(' AND ')}`;
    }
    
    const countQuery = `SELECT COUNT(DISTINCT a.Docnum) as total FROM DOME.dbo.[@XD_OSMP] a ${joinClause} ${whereClause}`;
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    const dataQuery = `
      Select DISTINCT
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
        a.U_DocEntry as [Document Entry],
        STUFF((
          SELECT DISTINCT ', ' +
            CASE b.U_status
              WHEN 'A' THEN 'Accepted'
              WHEN 'UI' THEN 'Under Inspection'
              WHEN 'P' THEN 'Pending'
              WHEN 'S' THEN 'Sampled'
              WHEN 'R' THEN 'Rejected'
              WHEN 'CA' THEN 'Conditionally Accepted'
              WHEN 'CR' THEN 'Conditionally Rejected'
              WHEN 'C' THEN 'Cancel'
              ELSE b.U_status
            END
          FROM DOME.dbo.[@XD_SMP1] b
          WHERE b.DocEntry = a.DocEntry
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 2, '') AS [Status]
        ${extraSelect}
      from DOME.dbo.[@XD_OSMP] a
      ${joinClause}
      ${whereClause}
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
      let currentDocEntry;
      let currentDocNum;
      let isUpdate = !!header.SamplingNo;

      if (isUpdate) {
        currentDocNum = header.SamplingNo;
        const checkReq = new sql.Request(transaction);
        checkReq.input('DocNum', sql.Int, currentDocNum);
        const checkRes = await checkReq.query(`SELECT DocEntry FROM DOME.dbo.[@XD_OSMP] WHERE DocNum = @DocNum`);
        if (checkRes.recordset.length === 0) {
            throw new Error('Record not found for update');
        }
        currentDocEntry = checkRes.recordset[0].DocEntry;
      } else {
        const entryRequest = new sql.Request(transaction);
        const entryRes = await entryRequest.query(`SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NewDocEntry FROM DOME.dbo.[@XD_OSMP]`);
        currentDocEntry = entryRes.recordset[0].NewDocEntry;
        currentDocNum = currentDocEntry;
      }
      
      // 2. Insert or Update Header
      const headerRequest = new sql.Request(transaction);
      headerRequest.input('DocEntry', sql.Int, currentDocEntry);
      headerRequest.input('DocNum', sql.Int, currentDocNum);
      headerRequest.input('U_SmpDate', sql.Date, header.SamplingDate ? new Date(header.SamplingDate) : new Date());
      headerRequest.input('U_Type', sql.Int, header.DocumentType);
      headerRequest.input('U_DocNum', sql.NVarChar, header.DocumentNumber ? String(header.DocumentNumber) : null);
      headerRequest.input('U_DocEntry', sql.Int, header.DocumentEntry ? parseInt(header.DocumentEntry) : null);
      headerRequest.input('U_CardCode', sql.NVarChar, header.SupplierCode ? String(header.SupplierCode) : null);
      headerRequest.input('U_CardName', sql.NVarChar, header.SupplierName ? String(header.SupplierName) : null);
      headerRequest.input('U_BPLId', sql.Int, 1);
      headerRequest.input('U_SmpBy', sql.NVarChar, header.UserEmpId ? String(header.UserEmpId) : null);
      headerRequest.input('U_SmpByName', sql.NVarChar, header.UserFirstName ? String(header.UserFirstName) : null);

      if (isUpdate) {
        await headerRequest.query(`
          UPDATE DOME.dbo.[@XD_OSMP] 
          SET U_SmpDate = @U_SmpDate, U_Type = @U_Type, U_DocNum = @U_DocNum, U_DocEntry = @U_DocEntry, 
              U_CardCode = @U_CardCode, U_Cardname = @U_CardName, U_BPLId = @U_BPLId, U_SmpBy = @U_SmpBy, U_SmpByName = @U_SmpByName
          WHERE DocEntry = @DocEntry
        `);
        
        // Delete old lines so we can re-insert them fresh
        const deleteLinesReq = new sql.Request(transaction);
        deleteLinesReq.input('DocEntry', sql.Int, currentDocEntry);
        await deleteLinesReq.query(`DELETE FROM DOME.dbo.[@XD_SMP1] WHERE DocEntry = @DocEntry`);
      } else {
        await headerRequest.query(`
          INSERT INTO DOME.dbo.[@XD_OSMP] 
          (DocEntry, DocNum, U_SmpDate, U_Type, U_DocNum, U_DocEntry, U_CardCode, U_Cardname, U_BPLId, U_SmpBy, U_SmpByName)
          VALUES 
          (@DocEntry, @DocNum, @U_SmpDate, @U_Type, @U_DocNum, @U_DocEntry, @U_CardCode, @U_CardName, @U_BPLId, @U_SmpBy, @U_SmpByName)
        `);
      }

      // 3. Insert Lines
      for (let i = 0; i < lines.length; i++) {
        const item = lines[i];
        const lineRequest = new sql.Request(transaction);

        lineRequest.input('DocEntry', sql.Int, currentDocEntry);
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
      res.json({ success: true, message: 'Sample saved successfully', docEntry: currentDocEntry });
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

const SAMPLE_STATUS_LABELS = {
  S: 'Sampled',
  UI: 'Under Inspection',
  P: 'Pending',
  A: 'Accepted',
  R: 'Rejected',
  CA: 'Conditionally Accepted',
  CR: 'Conditionally Rejected',
  C: 'Cancelled',
};

const labelSampleStatus = (code) => {
  if (!code) return null;
  return SAMPLE_STATUS_LABELS[code] || code;
};

const inspectionStatusFrom = (sampleCode, qcDecision) => {
  const decision = qcDecision || sampleCode;
  if (!sampleCode && !qcDecision) return 'Not started';
  if (['A', 'CA', 'R', 'CR'].includes(decision)) return 'Completed';
  if (decision === 'UI' || sampleCode === 'UI') return 'Under inspection';
  if (['S', 'P'].includes(sampleCode)) return 'Sampling';
  return labelSampleStatus(sampleCode) || 'Pending';
};

const dispositionFrom = (sampleCode, qcDecision) => {
  const decision = qcDecision || sampleCode;
  if (!sampleCode && !qcDecision) return 'Not started';
  if (['A', 'CA'].includes(decision)) return 'Released';
  if (['R', 'CR'].includes(decision)) return 'Rejected';
  if (decision === 'UI') return 'Under inspection';
  return 'Pending';
};

exports.getPostedGrns = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
        SELECT
          T.DocEntry,
          T.DocNum AS GrnNo,
          T.CardCode AS SupplierCode,
          T.CardName AS SupplierName,
          CONVERT(varchar(10), T.DocDate, 23) AS GrnDate,
          L.LineNum,
          L.ItemCode,
          L.Dscription AS ItemName,
          S.SamplingNo,
          SL.U_status AS SampleStatusCode,
          Q.U_QCDecision AS QcDecision,
          1 AS PostedToday
        FROM LDS_LIVE.dbo.OPDN T WITH (NOLOCK)
        INNER JOIN LDS_LIVE.dbo.PDN1 L WITH (NOLOCK) ON L.DocEntry = T.DocEntry
        INNER JOIN LDS_LIVE.dbo.OITM I WITH (NOLOCK) ON I.ItemCode = L.ItemCode
        OUTER APPLY (
          SELECT TOP 1 S.DocEntry AS SampleDocEntry, S.DocNum AS SamplingNo
          FROM DOME.dbo.[@XD_OSMP] S WITH (NOLOCK)
          WHERE S.U_Type = 20
            AND TRY_CAST(S.U_DocEntry AS INT) = T.DocEntry
            AND EXISTS (
              SELECT 1
              FROM DOME.dbo.[@XD_SMP1] X WITH (NOLOCK)
              WHERE X.DocEntry = S.DocEntry
                AND ISNULL(X.U_status COLLATE DATABASE_DEFAULT, '') <> 'C'
            )
          ORDER BY S.DocNum DESC
        ) S
        OUTER APPLY (
          SELECT TOP 1 X.U_status
          FROM DOME.dbo.[@XD_SMP1] X WITH (NOLOCK)
          WHERE X.DocEntry = S.SampleDocEntry
            AND ISNULL(X.U_status COLLATE DATABASE_DEFAULT, '') <> 'C'
            AND (
              X.U_BaseLine = L.LineNum
              OR X.U_ItemCode COLLATE DATABASE_DEFAULT = L.ItemCode COLLATE DATABASE_DEFAULT
            )
          ORDER BY CASE WHEN X.U_BaseLine = L.LineNum THEN 0 ELSE 1 END, X.LineId
        ) SL
        OUTER APPLY (
          SELECT TOP 1 Q.U_QCDecision
          FROM DOME.dbo.[@XD_OQUL] Q WITH (NOLOCK)
          WHERE S.SamplingNo IS NOT NULL
            AND Q.U_SampleNumber = S.SamplingNo
            AND (
              Q.U_Line = L.LineNum
              OR Q.U_ItemCode COLLATE DATABASE_DEFAULT = L.ItemCode COLLATE DATABASE_DEFAULT
            )
          ORDER BY Q.DocEntry DESC
        ) Q
        WHERE T.CANCELED = 'N'
          AND T.DocStatus = 'O'
          AND ISNULL(I.U_QCItem, '') = 'Y'
        ORDER BY T.DocDate DESC, T.DocNum DESC, L.LineNum;
      `);

    const postedRows = result.recordset || [];
    const rows = postedRows.map((row) => {
      const sampleCode = row.SampleStatusCode || null;
      const qcDecision = row.QcDecision || null;
      const sampled = sampleCode || row.SamplingNo ? 1 : 0;
      const underInspection = sampleCode === 'UI' || qcDecision === 'UI' ? 1 : 0;
      const disposition = dispositionFrom(sampleCode, qcDecision);
      return {
        DocEntry: row.DocEntry,
        GrnNo: row.GrnNo,
        SupplierCode: row.SupplierCode,
        SupplierName: row.SupplierName,
        GrnDate: row.GrnDate,
        LineNum: row.LineNum,
        ItemCode: row.ItemCode,
        ItemName: row.ItemName,
        SamplingNo: row.SamplingNo || null,
        Sampled: sampled,
        SampleStatus: labelSampleStatus(sampleCode) || (sampled ? 'Sampled' : 'Not sampled'),
        InspectionStatus: inspectionStatusFrom(sampleCode, qcDecision),
        Disposition: disposition,
        UnderInspection: underInspection,
      };
    });

    const posted = new Set(postedRows.map((row) => row.DocEntry)).size;
    const postedUnsampled = new Set(
      postedRows.filter((row) => !row.SampleStatusCode && !row.SamplingNo).map((row) => row.DocEntry)
    ).size;
    const sampledGrns = new Set(rows.filter((row) => row.Sampled === 1).map((row) => row.DocEntry || row.GrnNo));
    const uiGrns = new Set(rows.filter((row) => row.UnderInspection === 1).map((row) => row.DocEntry || row.GrnNo));
    const pendingDisposition = new Set(
      rows
        .filter((row) => row.Disposition === "Pending" || row.Disposition === "Under inspection")
        .map((row) => row.DocEntry || row.GrnNo)
    ).size;
    const openRows = rows.filter((row) => row.Sampled !== 1);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 20));
    const total = openRows.length;
    const offset = (page - 1) * limit;

    res.json({
      success: true,
      data: {
        posted,
        sampled: sampledGrns.size,
        notSampled: postedUnsampled,
        underInspection: uiGrns.size,
        pendingDisposition,
        rows: openRows.slice(offset, offset + limit),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit) || 1),
      },
    });
  } catch (err) {
    console.error('Error in getPostedGrns:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

