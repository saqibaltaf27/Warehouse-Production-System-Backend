const { sql, poolPromise } = require("../../database/connection");

class ComplaintsModel {
    static async lookupItems(company, search, pagination) {
        const pool = await poolPromise;
        const request = pool.request();
        
        let searchSql = "";
        if (search) {
            searchSql = ` AND (ItemCode LIKE @search OR ItemName LIKE @search OR FrgnName LIKE @search OR CodeBars LIKE @search) `;
            request.input('search', sql.VarChar, `%${search}%`);
        }

        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`
                SELECT 'GMS' AS Company, ItemCode, ItemName, ISNULL(U_Cat1, '') AS U_Cat1, '' AS U_Prod_line 
                FROM gms_live.dbo.OITM 
                WHERE FrozenFor = 'N' ${searchSql}
            `);
        }
        if (!company || company === 'LDS') {
            queries.push(`
                SELECT 'LDS' AS Company, ItemCode, ItemName, ISNULL(U_Cat1, '') AS U_Cat1, ISNULL(U_Prod_line, '') AS U_Prod_line 
                FROM lds_live.dbo.OITM 
                WHERE FrozenFor = 'N' ${searchSql}
            `);
        }

        let finalQuery = queries.join(" UNION ALL ");
        finalQuery += ` ORDER BY ItemCode ASC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

        const result = await request.query(finalQuery);
        return result.recordset || [];
    }

    static async generateComplaintNumber(productCode) {
        if (!productCode || productCode.length < 2) return null;
        
        const prefix = productCode.substring(0, 2).toUpperCase();
        const searchPattern = `${prefix}-%`;

        const pool = await poolPromise;
        const request = pool.request();
        request.input('searchPattern', sql.VarChar, searchPattern);

        const result = await request.query(`
            SELECT MAX(ComplaintNumber) AS MaxNumber 
            FROM Dome.dbo.PMSComplaints 
            WHERE ComplaintNumber LIKE @searchPattern
        `);

        const maxNumber = result.recordset[0]?.MaxNumber;
        let nextSequence = 1;

        if (maxNumber) {
            // maxNumber looks like "AC-001"
            const parts = maxNumber.split('-');
            if (parts.length === 2 && !isNaN(parts[1])) {
                nextSequence = parseInt(parts[1], 10) + 1;
            }
        }

        const paddedSequence = String(nextSequence).padStart(3, '0');
        return `${prefix}-${paddedSequence}`;
    }

    static async createComplaint(data) {
        const pool = await poolPromise;
        const request = pool.request();

        let complaintNumber = null;
        if (data.Product) {
            complaintNumber = await this.generateComplaintNumber(data.Product);
        }

        request.input('ComplaintNumber', sql.NVarChar, complaintNumber);
        request.input('Product', sql.NVarChar, data.Product || null);
        request.input('ProductCategory', sql.NVarChar, data.ProductCategory || null);
        request.input('ReportDate', sql.Date, data.ReportDate || null);
        request.input('Department', sql.NVarChar, data.Department || null);
        request.input('ComplaintBy', sql.NVarChar, data.ComplaintBy || null);
        request.input('Address', sql.NVarChar, data.Address || null);
        request.input('Contacts', sql.NVarChar, data.Contacts || null);
        request.input('InitiatedBy', sql.NVarChar, data.InitiatedBy || null);
        request.input('DeviationCategory', sql.NVarChar, data.DeviationCategory || null);
        request.input('BriefDescription', sql.NVarChar, data.BriefDescription || null);
        request.input('BatchNumber', sql.NVarChar, data.BatchNumber || null);
        request.input('RootCauseClass', sql.NVarChar, data.RootCauseClass || null);
        request.input('IdentifiedRootCause', sql.NVarChar, data.IdentifiedRootCause || null);
        request.input('ConcernedDepartment', sql.NVarChar, data.ConcernedDepartment || null);
        request.input('Stage1', sql.NVarChar, data.Stage1 || null);
        request.input('Stage2', sql.NVarChar, data.Stage2 || null);
        request.input('Stage3', sql.NVarChar, data.Stage3 || null);
        request.input('Stage4', sql.NVarChar, data.Stage4 || null);
        request.input('AdditionalRemarks', sql.NVarChar, data.AdditionalRemarks || null);
        request.input('CAPASummary', sql.NVarChar, data.CAPASummary || null);
        request.input('ClosingDate', sql.Date, data.ClosingDate || null);
        request.input('CumulativeFrequency', sql.Int, data.CumulativeFrequency || null);

        const result = await request.query(`
            INSERT INTO Dome.dbo.PMSComplaints (
                ComplaintNumber, Product, ProductCategory, ReportDate, Department, ComplaintBy, 
                Address, Contacts, InitiatedBy, DeviationCategory, BriefDescription, BatchNumber, 
                RootCauseClass, IdentifiedRootCause, ConcernedDepartment, Stage1, Stage2, Stage3, 
                Stage4, AdditionalRemarks, CAPASummary, ClosingDate, CumulativeFrequency, CreatedAt
            )
            VALUES (
                @ComplaintNumber, @Product, @ProductCategory, @ReportDate, @Department, @ComplaintBy, 
                @Address, @Contacts, @InitiatedBy, @DeviationCategory, @BriefDescription, @BatchNumber, 
                @RootCauseClass, @IdentifiedRootCause, @ConcernedDepartment, @Stage1, @Stage2, @Stage3, 
                @Stage4, @AdditionalRemarks, @CAPASummary, @ClosingDate, @CumulativeFrequency, GETDATE()
            )
        `);

        return { complaintNumber };
    }

    static async getAllComplaints(pagination) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        // Fetch total count
        const countResult = await request.query(`SELECT COUNT(*) AS Total FROM Dome.dbo.PMSComplaints`);
        const total = countResult.recordset[0].Total;

        // Fetch paginated data
        const result = await request.query(`
            SELECT 
                ComplaintNumber AS complaintNumber,
                Product AS product,
                ProductCategory AS productCategory,
                ReportDate AS reportDate,
                Department AS department,
                ComplaintBy AS complaintBy,
                Address AS address,
                Contacts AS contacts,
                InitiatedBy AS initiatedBy,
                DeviationCategory AS deviationCategory,
                BriefDescription AS briefDescription,
                BatchNumber AS batchNumber,
                RootCauseClass AS rootCauseClass,
                IdentifiedRootCause AS identifiedRootCause,
                ConcernedDepartment AS concernedDepartment,
                Stage1 AS stage1,
                Stage2 AS stage2,
                Stage3 AS stage3,
                Stage4 AS stage4,
                AdditionalRemarks AS additionalRemarks,
                CAPASummary AS capaSummary,
                ClosingDate AS closingDate,
                CumulativeFrequency AS cumulativeFrequency
            FROM Dome.dbo.PMSComplaints
            ORDER BY Id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

        return {
            total,
            data: result.recordset || []
        };
    }

    static async updateComplaint(complaintNumber, data, editedBy) {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);
        
        try {
            await transaction.begin();

            // 1. Fetch current record with UPDLOCK
            const request = new sql.Request(transaction);
            request.input('ComplaintNumber', sql.NVarChar, complaintNumber);
            
            const currentRecordResult = await request.query(`
                SELECT * FROM Dome.dbo.PMSComplaints WITH (UPDLOCK, HOLDLOCK)
                WHERE ComplaintNumber = @ComplaintNumber
            `);
            
            if (currentRecordResult.recordset.length === 0) {
                throw new Error("Complaint not found");
            }
            const oldData = currentRecordResult.recordset[0];

            // 2. Map fields to compare
            const fieldsToCompare = [
                { key: 'Product', dbKey: 'Product', type: sql.NVarChar },
                { key: 'ProductCategory', dbKey: 'ProductCategory', type: sql.NVarChar },
                { key: 'ReportDate', dbKey: 'ReportDate', type: sql.Date },
                { key: 'Department', dbKey: 'Department', type: sql.NVarChar },
                { key: 'ComplaintBy', dbKey: 'ComplaintBy', type: sql.NVarChar },
                { key: 'Address', dbKey: 'Address', type: sql.NVarChar },
                { key: 'Contacts', dbKey: 'Contacts', type: sql.NVarChar },
                { key: 'InitiatedBy', dbKey: 'InitiatedBy', type: sql.NVarChar },
                { key: 'DeviationCategory', dbKey: 'DeviationCategory', type: sql.NVarChar },
                { key: 'BriefDescription', dbKey: 'BriefDescription', type: sql.NVarChar },
                { key: 'BatchNumber', dbKey: 'BatchNumber', type: sql.NVarChar },
                { key: 'RootCauseClass', dbKey: 'RootCauseClass', type: sql.NVarChar },
                { key: 'IdentifiedRootCause', dbKey: 'IdentifiedRootCause', type: sql.NVarChar },
                { key: 'ConcernedDepartment', dbKey: 'ConcernedDepartment', type: sql.NVarChar },
                { key: 'Stage1', dbKey: 'Stage1', type: sql.NVarChar },
                { key: 'Stage2', dbKey: 'Stage2', type: sql.NVarChar },
                { key: 'Stage3', dbKey: 'Stage3', type: sql.NVarChar },
                { key: 'Stage4', dbKey: 'Stage4', type: sql.NVarChar },
                { key: 'AdditionalRemarks', dbKey: 'AdditionalRemarks', type: sql.NVarChar },
                { key: 'CAPASummary', dbKey: 'CAPASummary', type: sql.NVarChar },
                { key: 'ClosingDate', dbKey: 'ClosingDate', type: sql.Date },
                { key: 'CumulativeFrequency', dbKey: 'CumulativeFrequency', type: sql.Int }
            ];

            const changes = [];
            
            // Helper to format date strings to YYYY-MM-DD for comparison
            const formatDateStr = (val) => {
                if (!val) return null;
                const d = new Date(val);
                if (isNaN(d)) return String(val);
                return d.toISOString().split('T')[0];
            };

            for (const field of fieldsToCompare) {
                let oldVal = oldData[field.dbKey];
                let newVal = data[field.key] !== undefined ? data[field.key] : null;

                // Normalize both values to comparable strings
                let normOld, normNew;

                if (field.type === sql.Date) {
                    // Both dates normalized to YYYY-MM-DD
                    normOld = formatDateStr(oldVal) || '';
                    normNew = formatDateStr(newVal) || '';
                } else if (field.type === sql.Int) {
                    // Numbers: compare as numbers, treat null/empty/undefined as 0
                    const numOld = (oldVal === null || oldVal === undefined || oldVal === '') ? '' : String(Number(oldVal));
                    const numNew = (newVal === null || newVal === undefined || newVal === '') ? '' : String(Number(newVal));
                    normOld = numOld;
                    normNew = numNew;
                } else {
                    // Strings: trim and treat null/undefined as empty
                    normOld = (oldVal === null || oldVal === undefined) ? '' : String(oldVal).trim();
                    normNew = (newVal === null || newVal === undefined) ? '' : String(newVal).trim();
                }

                if (normOld !== normNew) {
                    changes.push({
                        FieldName: field.dbKey,
                        PreviousValue: normOld,
                        NewValue: normNew
                    });
                }
                
                // Add parameter to request for final UPDATE
                request.input(field.key, field.type, data[field.key] || null);
            }

            if (changes.length > 0) {
                // 4. Insert into PMSComplaintHistory as a single JSON row
                const oldValsJson = {};
                const newValsJson = {};
                
                for (const change of changes) {
                    oldValsJson[change.FieldName] = change.PreviousValue;
                    newValsJson[change.FieldName] = change.NewValue;
                }

                const histRequest = new sql.Request(transaction);
                histRequest.input('ComplaintNumber', sql.NVarChar, complaintNumber);
                histRequest.input('FieldName', sql.NVarChar, 'JSON_UPDATE');
                histRequest.input('PreviousValue', sql.NVarChar, JSON.stringify(oldValsJson));
                histRequest.input('NewValue', sql.NVarChar, JSON.stringify(newValsJson));
                histRequest.input('EditedBy', sql.NVarChar, editedBy);
                histRequest.input('ActionType', sql.NVarChar, 'UPDATE');
                
                await histRequest.query(`
                    INSERT INTO Dome.dbo.PMSComplaintHistory (
                        ComplaintNumber, FieldName, PreviousValue, 
                        NewValue, EditedBy, UpdatedAt, ActionType
                    ) VALUES (
                        @ComplaintNumber, @FieldName, @PreviousValue, 
                        @NewValue, @EditedBy, GETDATE(), @ActionType
                    )
                `);
            }

            // 5. Execute Update
            await request.query(`
                UPDATE Dome.dbo.PMSComplaints
                SET 
                    Product = @Product,
                    ProductCategory = @ProductCategory,
                    ReportDate = @ReportDate,
                    Department = @Department,
                    ComplaintBy = @ComplaintBy,
                    Address = @Address,
                    Contacts = @Contacts,
                    InitiatedBy = @InitiatedBy,
                    DeviationCategory = @DeviationCategory,
                    BriefDescription = @BriefDescription,
                    BatchNumber = @BatchNumber,
                    RootCauseClass = @RootCauseClass,
                    IdentifiedRootCause = @IdentifiedRootCause,
                    ConcernedDepartment = @ConcernedDepartment,
                    Stage1 = @Stage1,
                    Stage2 = @Stage2,
                    Stage3 = @Stage3,
                    Stage4 = @Stage4,
                    AdditionalRemarks = @AdditionalRemarks,
                    CAPASummary = @CAPASummary,
                    ClosingDate = @ClosingDate,
                    CumulativeFrequency = @CumulativeFrequency
                WHERE ComplaintNumber = @ComplaintNumber
            `);

            await transaction.commit();
            return { complaintNumber, changesApplied: changes.length };
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    static async getCOAProductDetails(itemCode) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('ItemCode', sql.NVarChar, itemCode);

        const query = `
            SELECT TOP 1
                T0.ItemName AS [PRODUCT],
                T0.ItemCode AS [ITEM CODE],
                T1.DistNumber AS [BATCH],
                CASE 
                    WHEN W.PlannedQty IS NOT NULL 
                    THEN CONCAT(CAST(W.PlannedQty AS DECIMAL(18,0)), ' ', ISNULL(T0.InvntryUom, '')) 
                    ELSE '' 
                END AS [BATCH SIZE],
                W.U_BMR AS [BMR NO.],
                ISNULL(T0.U_Type, '') AS [PROCESS STAGE],
                T0.SuppCatNum AS [CAT NO.],
                CASE 
                    WHEN NULLIF(LTRIM(RTRIM(T0.U_PackSize)), '') IS NULL THEN '' 
                    WHEN NULLIF(LTRIM(RTRIM(T0.CntUnitMsr)), '') IS NULL THEN LTRIM(RTRIM(T0.U_PackSize)) 
                    ELSE CONCAT(LTRIM(RTRIM(T0.U_PackSize)), ' ', LTRIM(RTRIM(T0.CntUnitMsr))) 
                END AS [PACK SIZE],
                CAST(T1.MnfDate AS DATE) AS [MFG DATE],
                CAST(T1.ExpDate AS DATE) AS [EXP DATE],
                CAST(GETDATE() AS DATE) AS [DATE REPORTED]
            FROM lds_live.dbo.OITM T0
            LEFT JOIN lds_live.dbo.OBTN T1 ON T1.ItemCode = T0.ItemCode
            OUTER APPLY (
                SELECT TOP 1 P.DocEntry, P.DocNum, P.PlannedQty, P.CmpltQty, P.PostDate, P.U_BMR
                FROM lds_live.dbo.OWOR P
                WHERE P.ItemCode = T0.ItemCode
                ORDER BY P.PostDate DESC, P.DocEntry DESC
            ) W
            WHERE T0.ItemCode = @ItemCode
            ORDER BY CASE WHEN T1.MnfDate IS NULL THEN 1 ELSE 0 END, T1.MnfDate DESC, T1.InDate DESC, T1.SysNumber DESC;
        `;
        
        const result = await request.query(query);
        return result.recordset[0] || null;
    }
}

module.exports = ComplaintsModel;
