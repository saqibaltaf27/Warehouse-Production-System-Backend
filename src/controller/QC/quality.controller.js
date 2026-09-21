const { sql, poolPromise } = require('../../database/connection');

exports.getQualityRecords = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);
    
    const countQuery = `SELECT COUNT(*) as total FROM DOME.dbo.[@XD_OQUL]`;
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    const dataQuery = `
      SELECT
          H.DocEntry AS [Document Entry],
          H.DocNum AS [Document Number],
          case when H.U_QCType = 'B' then 'Based on Document'
          else 'Standalone' end as [QC Type],
          case when H.U_Type = 'M' then 'Material' 
          else 'Process' end as [Type],
          H.U_RequestNo AS [Request Number],
          case when H.U_DocType = 20 then 'Goods Receipt PO'
          when H.U_DocType = 59 then 'Receipt From Production'
          when H.U_DocType = 16 then 'Sales Return'
          when H.U_DocType = 14 then 'A/R Credit Memo'
          end as [BaseType],
          H.U_BaseNum AS [Base Document No],
          H.U_CardCode AS [BP Code],
          H.U_CardName AS [BP Name],
          H.U_ItemCode AS [Item Code],
          H.U_ItemName AS [Item Name],
          H.U_SmpQty AS [Sample Qty],
          H.U_InsWhs AS [Inspection Warehouse],
          H.U_Supplier AS [Supplier Batch/Serial],
          H.U_BPLId AS [Branch],
          H.U_Series AS [Series],
          H.U_Line AS [Line No],
          H.U_Batch AS [Batch/Serial],
          H.U_ActualQty AS [Actual Quantity],
          H.U_Qty AS [Batch/Serial Quantity],
          H.U_ExpDate AS [Expiry Date],
          H.U_ReDate AS [Re-Test Date],
          H.U_InsITR AS [Inspection ITR],
          H.U_Manage AS [Managed By],
          H.U_SmpBy AS [Sample By],
          H.U_SmpByName AS [Sample By Name],
          H.U_InpBy AS [Inspected By],
          H.U_InpByName AS [Inspected By Name],
          H.U_AnlyzBy AS [Analyzed By],
          H.U_AnlyzByName AS [Analyzed By Name],
          H.U_RevBy AS [Reviewed By],
          H.U_RevByName AS [Reviewed By Name],
          H.U_RepBy AS [Report By],
          H.U_RepByName AS [Report By Name],
          CASE WHEN H.U_QCDecision = 'A' THEN 'Accepted'
               WHEN H.U_QCDecision = 'R' THEN 'Rejected'
               WHEN H.U_QCDecision = 'CA' THEN 'Conditionally Accepted'
               WHEN H.U_QCDecision = 'CR' THEN 'Conditionally Rejected'
               ELSE H.U_QCDecision END AS [QC Decision],
          H.U_AccpQty AS [Accepted Qty],
          H.U_RejQty AS [Rejected Qty],
          H.U_AcpWhs AS [Release Warehouse],
          H.U_RejWhs AS [Rejection Warehouse],
          H.U_AcpITR AS [Accepted ITR],
          H.U_RejITR AS [Rejected ITR],
          H.CreateDate AS [Create Date],
          H.UpdateDate AS [Update Date]
      FROM DOME.dbo.[@XD_OQUL] H
      ORDER BY H.DocEntry DESC
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
    console.error("Error in getQualityRecords:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getQualityRecordDetails = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const pool = await poolPromise;
    const request = pool.request();
    request.input('DocEntry', sql.Int, parseInt(docEntry));

    const query = `
      SELECT
          H.DocEntry AS [Document Entry],
          H.DocNum AS [Document Number],
          case when H.U_QCType = 'B' then 'Based on Document'
          else 'Standalone' end as [QC Type],
          case when H.U_Type = 'M' then 'Material' 
          else 'Process' end as [Type],
          H.U_RequestNo AS [Request Number],
          case when H.U_DocType = 20 then 'Goods Receipt PO'
          when H.U_DocType = 59 then 'Receipt From Production'
          when H.U_DocType = 16 then 'Sales Return'
          when H.U_DocType = 14 then 'A/R Credit Memo'
          end as [BaseType],
          H.U_BaseNum AS [Base Document No],
          H.U_CardCode AS [BP Code],
          H.U_CardName AS [BP Name],
          H.U_ItemCode AS [Item Code],
          H.U_ItemName AS [Item Name],
          H.U_SmpQty AS [Sample Qty],
          H.U_InsWhs AS [Inspection Warehouse],
          H.U_Supplier AS [Supplier Batch/Serial],
          H.U_BPLId AS [Branch],
          H.U_Series AS [Series],
          H.U_Line AS [Line No],
          H.U_Batch AS [Batch/Serial],
          H.U_ActualQty AS [Actual Quantity],
          H.U_Qty AS [Batch/Serial Quantity],
          H.U_ExpDate AS [Expiry Date],
          H.U_ReDate AS [Re-Test Date],
          H.U_InsITR AS [Inspection ITR],
          H.U_Manage AS [Managed By],
          H.U_SmpBy AS [Sample By],
          H.U_SmpByName AS [Sample By Name],
          H.U_InpBy AS [Inspected By],
          H.U_InpByName AS [Inspected By Name],
          H.U_AnlyzBy AS [Analyzed By],
          H.U_AnlyzByName AS [Analyzed By Name],
          H.U_RevBy AS [Reviewed By],
          H.U_RevByName AS [Reviewed By Name],
          H.U_RepBy AS [Report By],
          H.U_RepByName AS [Report By Name],
          CASE WHEN H.U_QCDecision = 'A' THEN 'Accepted'
               WHEN H.U_QCDecision = 'R' THEN 'Rejected'
               WHEN H.U_QCDecision = 'CA' THEN 'Conditionally Accepted'
               WHEN H.U_QCDecision = 'CR' THEN 'Conditionally Rejected'
               ELSE H.U_QCDecision END AS [QC Decision],
          H.U_AccpQty AS [Accepted Qty],
          H.U_RejQty AS [Rejected Qty],
          H.U_AcpWhs AS [Release Warehouse],
          H.U_RejWhs AS [Rejection Warehouse],
          H.U_AcpITR AS [Accepted ITR],
          H.U_RejITR AS [Rejected ITR],
          H.CreateDate AS [Create Date],
          H.UpdateDate AS [Update Date],
          D.LineId AS [Parameter Line],
          D.U_PrmCode AS [Parameter Code],
          D.U_PrmName AS [Parameter Name],
          D.U_Action AS [Action],
          D.U_Criteria AS [Criteria],
          D.U_EqpCode AS [Equipment Code],
          D.U_EqpName AS [Equipment Name],
          D.U_Uom AS [UOM],
          D.U_StdValue AS [Std Value],
          D.U_MinValue AS [Min Value],
          D.U_MaxValue AS [Max Value],
          D.U_Type AS [Parameter Type],
          D.U_ObValue1 AS [Observed Value 1],
          D.U_ObValue2 AS [Observed Value 2],
          D.U_ObValue3 AS [Observed Value 3]
      FROM DOME.dbo.[@XD_OQUL] H
      LEFT JOIN DOME.dbo.[@XD_QUL1] D
          ON D.DocEntry = H.DocEntry
      WHERE H.DocEntry = @DocEntry
      ORDER BY D.LineId
    `;
    
    const dataResult = await request.query(query);
    
    if (dataResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Quality record not found' });
    }
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getQualityRecordDetails:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getItems = async (req, res) => {
  try {
    const { search = '' } = req.query;
    const pool = await poolPromise;
    const request = pool.request();
    
    request.input('search', sql.NVarChar, `%${search}%`);
    
    let query = `
      SELECT 
        ItemCode, 
        ItemName 
      FROM LDS_live.dbo.OITM
    `;

    if (search) {
      query += ` WHERE ItemCode LIKE @search OR ItemName LIKE @search`;
    }

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getItems:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getItemByCode = async (req, res) => {
  try {
    const { itemCode } = req.query;
    if (!itemCode) {
      return res.status(400).json({ success: false, message: 'ItemCode is required' });
    }
    
    const pool = await poolPromise;
    const request = pool.request();
    
    request.input('ItemCode', sql.NVarChar, itemCode);
    
    const query = `
      SELECT * 
      FROM [DOME].[dbo].[@XD_OITS]
      WHERE U_ItemCode = @ItemCode
    `;

    const dataResult = await request.query(query);
    
    if (dataResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found in @XD_OITS' });
    }
    
    const headerData = dataResult.recordset[0];
    const docEntry = headerData.DocEntry;

    request.input('DocEntry', sql.Int, docEntry);
    const linesQuery = `
      SELECT *
      FROM [DOME].[dbo].[@XD_ITS1]
      WHERE DocEntry = @DocEntry
      ORDER BY LineId
    `;
    const linesResult = await request.query(linesQuery);
    
    res.json({
      success: true,
      data: headerData,
      lines: linesResult.recordset
    });
  } catch (err) {
    console.error("Error in getItemByCode:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getEquipments = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const query = `
      SELECT DISTINCT 
          U_EqpCode,
          U_EqpName
      FROM [DOME].[dbo].[@XD_ITS1]
      WHERE U_EqpCode IS NOT NULL AND RTRIM(LTRIM(U_EqpCode)) <> ''
      ORDER BY U_EqpName ASC;
    `;

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getEquipments:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getParameters = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const query = `
      SELECT DISTINCT 
          Code,
          Name
      FROM [DOME].[dbo].[@XD_OQCP]
      WHERE Code IS NOT NULL AND RTRIM(LTRIM(Code)) <> ''
      ORDER BY Name ASC;
    `;

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getParameters:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNextDocEntry = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const query = `
      SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NextDocEntry
      FROM [DOME].[dbo].[@XD_OQUL]
    `;

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      nextDocEntry: dataResult.recordset[0].NextDocEntry
    });
  } catch (err) {
    console.error("Error in getNextDocEntry:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getItemBatches = async (req, res) => {
  try {
    const { itemCode } = req.query;
    if (!itemCode) {
      return res.status(400).json({ success: false, message: 'ItemCode is required' });
    }

    const pool = await poolPromise;
    const request = pool.request();
    request.input('itemCode', sql.NVarChar, itemCode);
    
    const query = `
      SELECT 
          DistNumber AS BatchSerial, 
          Quantity AS Qty, 
          'Batch' AS ManageType,
          MnfDate,
          ExpDate
      FROM LDS_LIVE.dbo.OBTN 
      WHERE ItemCode = @itemCode
      UNION ALL
      SELECT 
          DistNumber AS BatchSerial, 
          Quantity AS Qty, 
          'Serial' AS ManageType,
          MnfDate,
          ExpDate
      FROM LDS_LIVE.dbo.OSRN 
      WHERE ItemCode = @itemCode
    `;

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getItemBatches:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getEmployees = async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    
    const query = `
      SELECT EmpID, FirstName 
      FROM HCM_GMS.dbo.MstEmployee 
      WHERE (DepartmentName LIKE '%warehouse%' 
             OR DepartmentName LIKE '%production%' 
             OR DepartmentName LIKE '%Quality%') 
        AND flgActive = 1
      ORDER BY FirstName ASC
    `;

    const dataResult = await request.query(query);
    
    res.json({
      success: true,
      data: dataResult.recordset
    });
  } catch (err) {
    console.error("Error in getEmployees:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createQualityRecord = async (req, res) => {
  try {
    const data = req.body;
    const pool = await poolPromise;
    const request = pool.request();
    
    // Get next DocEntry and DocNum
    const docEntryResult = await request.query(`SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NextDocEntry FROM [DOME].[dbo].[@XD_OQUL]`);
    const docEntry = docEntryResult.recordset[0].NextDocEntry;
    
    // Begin transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    
    try {
      const txRequest = new sql.Request(transaction);
      
      // INSERT into Header Table [@XD_OQUL]
      txRequest.input('DocEntry', sql.Int, docEntry);
      txRequest.input('DocNum', sql.Int, docEntry); // Assuming DocNum is same as DocEntry for custom tables usually
      txRequest.input('U_QCType', sql.NVarChar, data.qcType || 'S'); // 'B' for Based on Document, 'S' for Standalone
      txRequest.input('U_Type', sql.NVarChar, data.type || 'M'); // 'M' Material or 'P' Process
      txRequest.input('U_ItemCode', sql.NVarChar, data.itemCode);
      txRequest.input('U_ItemName', sql.NVarChar, data.itemName);
      txRequest.input('U_SmpQty', sql.Numeric, data.sampleQty ? parseFloat(data.sampleQty) : null);
      txRequest.input('U_Batch', sql.NVarChar, data.selectedBatch);
      txRequest.input('U_Qty', sql.Numeric, data.batchQty ? parseFloat(data.batchQty) : null);
      txRequest.input('U_ExpDate', sql.Date, data.batchExpDate ? new Date(data.batchExpDate) : null);
      txRequest.input('CreateDate', sql.DateTime, new Date());
      // Auth context mappings
      txRequest.input('U_InpBy', sql.NVarChar, data.inspectedBy || data.empId || null);
      txRequest.input('U_InpByName', sql.NVarChar, data.inspectedByName || data.empName || null);
      
      // Additional Fields
      txRequest.input('U_SmpBy', sql.NVarChar, data.sampleBy || null);
      txRequest.input('U_SmpByName', sql.NVarChar, data.sampleByName || null);
      txRequest.input('U_AnlyzBy', sql.NVarChar, data.analyzedBy || null);
      txRequest.input('U_AnlyzByName', sql.NVarChar, data.analyzedByName || null);
      txRequest.input('U_RevBy', sql.NVarChar, data.reviewedBy || null);
      txRequest.input('U_RevByName', sql.NVarChar, data.reviewedByName || null);
      txRequest.input('U_RepBy', sql.NVarChar, data.reportBy || null);
      txRequest.input('U_RepByName', sql.NVarChar, data.reportByName || null);
      txRequest.input('U_QCDecision', sql.NVarChar, data.qcDecision || 'A');
      txRequest.input('U_AccpQty', sql.Numeric, data.acceptedQty ? parseFloat(data.acceptedQty) : null);
      txRequest.input('U_RejQty', sql.Numeric, data.rejectedQty ? parseFloat(data.rejectedQty) : null);
      txRequest.input('U_AcpWhs', sql.NVarChar, data.releaseWarehouse || null);
      txRequest.input('U_RejWhs', sql.NVarChar, data.rejectionWarehouse || null);
      txRequest.input('U_AcpITR', sql.NVarChar, data.acceptedITR || null);
      txRequest.input('U_RejITR', sql.NVarChar, data.rejectedITR || null);

      const insertHeaderQuery = `
        INSERT INTO [DOME].[dbo].[@XD_OQUL] (
          DocEntry, DocNum, U_QCType, U_Type, U_ItemCode, U_ItemName, 
          U_SmpQty, U_Batch, U_Qty, U_ExpDate, CreateDate, U_InpBy, U_InpByName,
          U_SmpBy, U_SmpByName, U_AnlyzBy, U_AnlyzByName, U_RevBy, U_RevByName, U_RepBy, U_RepByName,
          U_QCDecision, U_AccpQty, U_RejQty, U_AcpWhs, U_RejWhs, U_AcpITR, U_RejITR
        ) VALUES (
          @DocEntry, @DocNum, @U_QCType, @U_Type, @U_ItemCode, @U_ItemName, 
          @U_SmpQty, @U_Batch, @U_Qty, @U_ExpDate, @CreateDate, @U_InpBy, @U_InpByName,
          @U_SmpBy, @U_SmpByName, @U_AnlyzBy, @U_AnlyzByName, @U_RevBy, @U_RevByName, @U_RepBy, @U_RepByName,
          @U_QCDecision, @U_AccpQty, @U_RejQty, @U_AcpWhs, @U_RejWhs, @U_AcpITR, @U_RejITR
        )
      `;
      
      await txRequest.query(insertHeaderQuery);

      // INSERT into Lines Table [@XD_QUL1]
      if (data.lines && data.lines.length > 0) {
        for (let i = 0; i < data.lines.length; i++) {
          const line = data.lines[i];
          const lineRequest = new sql.Request(transaction);
          
          lineRequest.input('DocEntry', sql.Int, docEntry);
          lineRequest.input('LineId', sql.Int, i + 1);
          lineRequest.input('U_PrmCode', sql.NVarChar, line['Parameter Code']);
          lineRequest.input('U_PrmName', sql.NVarChar, line['Parameter Name']);
          lineRequest.input('U_Action', sql.NVarChar, line['Action']);
          lineRequest.input('U_Criteria', sql.NVarChar, line['Criteria']);
          lineRequest.input('U_EqpCode', sql.NVarChar, line['Equipment Code']);
          lineRequest.input('U_EqpName', sql.NVarChar, line['Equipment Name']);
          lineRequest.input('U_Uom', sql.NVarChar, line['UOM']);
          lineRequest.input('U_StdValue', sql.NVarChar, line['Std Value']);
          lineRequest.input('U_MinValue', sql.NVarChar, line['Min Value']);
          lineRequest.input('U_MaxValue', sql.NVarChar, line['Max Value']);
          lineRequest.input('U_Type', sql.NVarChar, line['Type'] || line['Parameter Type']);
          lineRequest.input('U_ObValue1', sql.NVarChar, line['Observed Value 1']);
          lineRequest.input('U_ObValue2', sql.NVarChar, line['Observed Value 2']);
          lineRequest.input('U_ObValue3', sql.NVarChar, line['Observed Value 3']);
          
          const insertLineQuery = `
            INSERT INTO [DOME].[dbo].[@XD_QUL1] (
              DocEntry, LineId, U_PrmCode, U_PrmName, U_Action, U_Criteria,
              U_EqpCode, U_EqpName, U_Uom, U_StdValue, U_MinValue, U_MaxValue,
              U_Type, U_ObValue1, U_ObValue2, U_ObValue3
            ) VALUES (
              @DocEntry, @LineId, @U_PrmCode, @U_PrmName, @U_Action, @U_Criteria,
              @U_EqpCode, @U_EqpName, @U_Uom, @U_StdValue, @U_MinValue, @U_MaxValue,
              @U_Type, @U_ObValue1, @U_ObValue2, @U_ObValue3
            )
          `;
          
          await lineRequest.query(insertLineQuery);
        }
      }

      await transaction.commit();
      
      res.json({
        success: true,
        message: 'Quality record created successfully',
        docEntry: docEntry
      });
      
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }
    
  } catch (err) {
    console.error("Error in createQualityRecord:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.saveQCParameters = async (req, res) => {
  try {
    const { itemCode, sampleSize, lines } = req.body;

    if (!itemCode) {
      return res.status(400).json({ success: false, message: 'ItemCode is required' });
    }

    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Check if standard exists
      const checkRequest = new sql.Request(transaction);
      checkRequest.input('ItemCode', sql.NVarChar, itemCode);
      
      const checkQuery = `
        SELECT DocEntry
        FROM [DOME].[dbo].[@XD_OITS]
        WHERE U_ItemCode = @ItemCode
      `;
      
      const checkResult = await checkRequest.query(checkQuery);
      let docEntry;

      if (checkResult.recordset.length > 0) {
        // Exists: Update header
        docEntry = checkResult.recordset[0].DocEntry;
        
        const updateRequest = new sql.Request(transaction);
        updateRequest.input('DocEntry', sql.Int, docEntry);
        updateRequest.input('SampleSize', sql.Numeric, sampleSize || null);
        
        const updateQuery = `
          UPDATE [DOME].[dbo].[@XD_OITS]
          SET U_SampleSize = @SampleSize
          WHERE DocEntry = @DocEntry
        `;
        await updateRequest.query(updateQuery);

        // Delete existing lines
        const deleteLinesRequest = new sql.Request(transaction);
        deleteLinesRequest.input('DocEntry', sql.Int, docEntry);
        await deleteLinesRequest.query(`DELETE FROM [DOME].[dbo].[@XD_ITS1] WHERE DocEntry = @DocEntry`);
      } else {
        // New standard: Create header
        const nextIdRequest = new sql.Request(transaction);
        const nextIdResult = await nextIdRequest.query(`SELECT ISNULL(MAX(DocEntry), 0) + 1 AS NextDocEntry FROM [DOME].[dbo].[@XD_OITS]`);
        docEntry = nextIdResult.recordset[0].NextDocEntry;

        const insertRequest = new sql.Request(transaction);
        insertRequest.input('DocEntry', sql.Int, docEntry);
        insertRequest.input('ItemCode', sql.NVarChar, itemCode);
        insertRequest.input('SampleSize', sql.Numeric, sampleSize || null);

        const insertQuery = `
          INSERT INTO [DOME].[dbo].[@XD_OITS] (DocEntry, U_ItemCode, U_SampleSize)
          VALUES (@DocEntry, @ItemCode, @SampleSize)
        `;
        await insertRequest.query(insertQuery);
      }

      // Insert new lines
      if (lines && lines.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineRequest = new sql.Request(transaction);
          
          lineRequest.input('DocEntry', sql.Int, docEntry);
          lineRequest.input('LineId', sql.Int, i + 1);
          lineRequest.input('U_PrmCode', sql.NVarChar, line['Parameter Code'] || null);
          lineRequest.input('U_PrmName', sql.NVarChar, line['Parameter Name'] || null);
          lineRequest.input('U_Action', sql.NVarChar, line['Action'] || null);
          lineRequest.input('U_Criteria', sql.NVarChar, line['Criteria'] || null);
          lineRequest.input('U_EqpCode', sql.NVarChar, line['Equipment Code'] || null);
          lineRequest.input('U_EqpName', sql.NVarChar, line['Equipment Name'] || null);
          lineRequest.input('U_PrmUom', sql.NVarChar, line['UOM'] || null);
          lineRequest.input('U_StdValue', sql.NVarChar, line['Std Value'] || null);
          lineRequest.input('U_MinValue', sql.NVarChar, line['Min Value'] || null);
          lineRequest.input('U_MaxValue', sql.NVarChar, line['Max Value'] || null);
          lineRequest.input('U_Type', sql.NVarChar, line['Type'] || null);

          const insertLineQuery = `
            INSERT INTO [DOME].[dbo].[@XD_ITS1] (
              DocEntry, LineId, U_PrmCode, U_PrmName, U_Action, U_Criteria, 
              U_EqpCode, U_EqpName, U_PrmUom, U_StdValue, U_MinValue, U_MaxValue, U_Type
            ) VALUES (
              @DocEntry, @LineId, @U_PrmCode, @U_PrmName, @U_Action, @U_Criteria, 
              @U_EqpCode, @U_EqpName, @U_PrmUom, @U_StdValue, @U_MinValue, @U_MaxValue, @U_Type
            )
          `;
          await lineRequest.query(insertLineQuery);
        }
      }

      await transaction.commit();
      
      res.json({
        success: true,
        message: 'QC Parameters saved successfully'
      });
      
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }
    
  } catch (err) {
    console.error("Error in saveQCParameters:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
