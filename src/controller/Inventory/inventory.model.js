const { sql, poolPromise } = require("../../database/connection");

class InventoryModel {

    static applyFilters(filters, req, tableAlias = '') {
        let where = "";
        if (filters.fiscalYear) {
            const [startYear, endYear] = filters.fiscalYear.split('-');
            if (startYear && endYear) {
                where += ` AND ${tableAlias}CreateDate >= @fyStart AND ${tableAlias}CreateDate < @fyEnd `;
                if (!req.parameters.fyStart) {
                    req.input('fyStart', sql.Date, new Date(`${startYear}-07-01`));
                    req.input('fyEnd', sql.Date, new Date(`${endYear}-07-01`));
                }
            }
        }
        if (filters.group) {
            where += ` AND ${tableAlias}ItmsGrpCod = @group `;
            if (!req.parameters.group) req.input('group', sql.Int, parseInt(filters.group, 10));
        }
        if (filters.category) {
            where += ` AND ${tableAlias}U_Cat1 = @category `;
            if (!req.parameters.category) req.input('category', sql.VarChar, filters.category);
        }
        return where;
    }

    static async getInventoryFilters(company) {
        try {
            const pool = await poolPromise;
            
            const companies = [
                { value: 'GMS', label: 'GMS' },
                { value: 'LDS', label: 'LDS' }
            ];

            // Build query dynamically with UNION based on the selected company            // Since multiple sets are returned, we will aggregate them uniquely in code if both DBs are queried.
            // But for simplicity and to match previous structure with UNION:
            const sqlQuery = `
                SELECT DISTINCT value, label FROM (
                    SELECT ItmsGrpCod AS value, ItmsGrpNam AS label FROM gms_live.dbo.OITB WHERE 'GMS' = ISNULL(@company, 'GMS') OR @company IS NULL
                    UNION
                    SELECT ItmsGrpCod AS value, ItmsGrpNam AS label FROM lds_live.dbo.OITB WHERE 'LDS' = ISNULL(@company, 'LDS') OR @company IS NULL
                ) AS Q1;

                SELECT DISTINCT value, label FROM (
                    SELECT WhsCode AS value, WhsName AS label FROM gms_live.dbo.OWHS WHERE 'GMS' = ISNULL(@company, 'GMS') OR @company IS NULL
                    UNION
                    SELECT WhsCode AS value, WhsName AS label FROM lds_live.dbo.OWHS WHERE 'LDS' = ISNULL(@company, 'LDS') OR @company IS NULL
                ) AS Q2;

                SELECT DISTINCT value, label FROM (
                    SELECT 
                        CASE WHEN MONTH(CreateDate) >= 7 THEN CAST(YEAR(CreateDate) AS VARCHAR) + '-' + CAST(YEAR(CreateDate) + 1 AS VARCHAR)
                        ELSE CAST(YEAR(CreateDate) - 1 AS VARCHAR) + '-' + CAST(YEAR(CreateDate) AS VARCHAR) END AS value,
                        CASE WHEN MONTH(CreateDate) >= 7 THEN CAST(YEAR(CreateDate) AS VARCHAR) + '-' + CAST(YEAR(CreateDate) + 1 AS VARCHAR)
                        ELSE CAST(YEAR(CreateDate) - 1 AS VARCHAR) + '-' + CAST(YEAR(CreateDate) AS VARCHAR) END AS label
                    FROM gms_live.dbo.OITM WHERE CreateDate IS NOT NULL AND ('GMS' = ISNULL(@company, 'GMS') OR @company IS NULL)
                    UNION
                    SELECT 
                        CASE WHEN MONTH(CreateDate) >= 7 THEN CAST(YEAR(CreateDate) AS VARCHAR) + '-' + CAST(YEAR(CreateDate) + 1 AS VARCHAR)
                        ELSE CAST(YEAR(CreateDate) - 1 AS VARCHAR) + '-' + CAST(YEAR(CreateDate) AS VARCHAR) END AS value,
                        CASE WHEN MONTH(CreateDate) >= 7 THEN CAST(YEAR(CreateDate) AS VARCHAR) + '-' + CAST(YEAR(CreateDate) + 1 AS VARCHAR)
                        ELSE CAST(YEAR(CreateDate) - 1 AS VARCHAR) + '-' + CAST(YEAR(CreateDate) AS VARCHAR) END AS label
                    FROM lds_live.dbo.OITM WHERE CreateDate IS NOT NULL AND ('LDS' = ISNULL(@company, 'LDS') OR @company IS NULL)
                ) AS Q3 ORDER BY value DESC;

                SELECT DISTINCT value, label FROM (
                    SELECT U_Cat1 AS value, U_Cat1 AS label FROM gms_live.dbo.OITM WHERE U_Cat1 IS NOT NULL AND ('GMS' = ISNULL(@company, 'GMS') OR @company IS NULL)
                    UNION
                    SELECT U_Cat1 AS value, U_Cat1 AS label FROM lds_live.dbo.OITM WHERE U_Cat1 IS NOT NULL AND ('LDS' = ISNULL(@company, 'LDS') OR @company IS NULL)
                ) AS Q4;
            `;

            const request = pool.request();
            request.input('company', sql.VarChar, company || null);
            const result = await request.query(sqlQuery);

            return {
                companies: companies,
                itemGroups: result.recordsets[0],
                warehouses: result.recordsets[1],
                fiscalYears: result.recordsets[2],
                categories: result.recordsets[3]
            };
        } catch (error) {
            throw error;
        }
    }

    static async getInventoryDashboardItems(pagination, sorting, filters) {
        const pool = await poolPromise;
        const request = pool.request();

        const filterSqlT2 = this.applyFilters(filters, request, 'T2.');
        let warehouseFilterGMS = filters.warehouse ? " AND T1.WhsCode = @warehouse " : "";
        let warehouseFilterLDS = filters.warehouse ? " AND T1.WhsCode = @warehouse " : "";
        if (filters.warehouse && !request.parameters.warehouse) {
            request.input('warehouse', sql.VarChar, filters.warehouse);
        }

        let searchCondition = "";
        if (filters.search) {
            searchCondition = " AND (T0.ItemCode LIKE @search OR T2.ItemName LIKE @search OR T0.DistNumber LIKE @search) ";
            request.input('search', sql.VarChar, `%${filters.search}%`);
        }

        let bucketCondition = "";
        if (filters.agingBucket && filters.agingBucket !== 'ALL') {
            bucketCondition = " AND AgingBucket = @agingBucket ";
            request.input('agingBucket', sql.VarChar, filters.agingBucket);
        }

        let sortCol = 'ExpiryDate';
        if (sorting.sortBy === 'ItemCode') sortCol = 'ItemCode';
        else if (sorting.sortBy === 'ItemName') sortCol = 'ItemName';
        else if (sorting.sortBy === 'BatchNumber') sortCol = 'BatchNumber';
        else if (sorting.sortBy === 'DaysToExpiry') sortCol = 'DaysToExpiry';
        else if (sorting.sortBy === 'StockQty') sortCol = 'StockQty';
        else if (sorting.sortBy === 'Company') sortCol = 'Company';
        
        const sortOrder = sorting.sortOrder === 'DESC' ? 'DESC' : 'ASC';

        let queries = [];
        if (!filters.company || filters.company === 'GMS') {
            // GMS Batches (OBTN)
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    'Batch' AS TrackingType,
                    T0.ItemCode,
                    T2.ItemName,
                    T2.FrgnName,
                    T2.U_Cat1 AS Category,
                    T0.DistNumber AS BatchNumber,
                    T0.ExpDate AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry,
                    SUM(T1.Quantity) AS StockQty,
                    ISNULL(T2.LstEvlPric, 0) AS UnitPrice,
                    (SUM(T1.Quantity) * ISNULL(T2.LstEvlPric, 0)) AS StockValue
                FROM gms_live.dbo.OBTN T0
                INNER JOIN gms_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                INNER JOIN gms_live.dbo.OITM T2 ON T0.ItemCode = T2.ItemCode
                WHERE T1.Quantity > 0
                  AND T0.ExpDate IS NOT NULL
                  ${warehouseFilterGMS}
                  ${filterSqlT2}
                GROUP BY T0.ItemCode, T2.ItemName, T2.FrgnName, T2.U_Cat1, T0.DistNumber, T0.ExpDate, T2.LstEvlPric
                HAVING SUM(T1.Quantity) > 0
            `);
            // GMS Serials (OSRN)
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    'Serial' AS TrackingType,
                    T0.ItemCode,
                    T2.ItemName,
                    T2.FrgnName,
                    T2.U_Cat1 AS Category,
                    T0.DistNumber AS BatchNumber,
                    T0.ExpDate AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry,
                    SUM(T1.Quantity) AS StockQty,
                    ISNULL(T2.LstEvlPric, 0) AS UnitPrice,
                    (SUM(T1.Quantity) * ISNULL(T2.LstEvlPric, 0)) AS StockValue
                FROM gms_live.dbo.OSRN T0
                INNER JOIN gms_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                INNER JOIN gms_live.dbo.OITM T2 ON T0.ItemCode = T2.ItemCode
                WHERE T1.Quantity > 0
                  AND T0.ExpDate IS NOT NULL
                  ${warehouseFilterGMS}
                  ${filterSqlT2}
                GROUP BY T0.ItemCode, T2.ItemName, T2.FrgnName, T2.U_Cat1, T0.DistNumber, T0.ExpDate, T2.LstEvlPric
                HAVING SUM(T1.Quantity) > 0
            `);
        }
        if (!filters.company || filters.company === 'LDS') {
            // LDS Batches (OBTN)
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    'Batch' AS TrackingType,
                    T0.ItemCode,
                    T2.ItemName,
                    T2.FrgnName,
                    T2.U_Cat1 AS Category,
                    T0.DistNumber AS BatchNumber,
                    T0.ExpDate AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry,
                    SUM(T1.Quantity) AS StockQty,
                    ISNULL(T2.LstEvlPric, 0) AS UnitPrice,
                    (SUM(T1.Quantity) * ISNULL(T2.LstEvlPric, 0)) AS StockValue
                FROM lds_live.dbo.OBTN T0
                INNER JOIN lds_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                INNER JOIN lds_live.dbo.OITM T2 ON T0.ItemCode = T2.ItemCode
                WHERE T1.Quantity > 0
                  AND T0.ExpDate IS NOT NULL
                  ${warehouseFilterLDS}
                  ${filterSqlT2}
                GROUP BY T0.ItemCode, T2.ItemName, T2.FrgnName, T2.U_Cat1, T0.DistNumber, T0.ExpDate, T2.LstEvlPric
                HAVING SUM(T1.Quantity) > 0
            `);
            // LDS Serials (OSRN)
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    'Serial' AS TrackingType,
                    T0.ItemCode,
                    T2.ItemName,
                    T2.FrgnName,
                    T2.U_Cat1 AS Category,
                    T0.DistNumber AS BatchNumber,
                    T0.ExpDate AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry,
                    SUM(T1.Quantity) AS StockQty,
                    ISNULL(T2.LstEvlPric, 0) AS UnitPrice,
                    (SUM(T1.Quantity) * ISNULL(T2.LstEvlPric, 0)) AS StockValue
                FROM lds_live.dbo.OSRN T0
                INNER JOIN lds_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                INNER JOIN lds_live.dbo.OITM T2 ON T0.ItemCode = T2.ItemCode
                WHERE T1.Quantity > 0
                  AND T0.ExpDate IS NOT NULL
                  ${warehouseFilterLDS}
                  ${filterSqlT2}
                GROUP BY T0.ItemCode, T2.ItemName, T2.FrgnName, T2.U_Cat1, T0.DistNumber, T0.ExpDate, T2.LstEvlPric
                HAVING SUM(T1.Quantity) > 0
            `);
        }

        const rawUnionSql = queries.join(" UNION ALL ");

        let paginationSql = "";
        if (pagination.limit && pagination.limit > 0) {
            request.input('limit', sql.Int, pagination.limit);
            request.input('offset', sql.Int, pagination.offset || 0);
            paginationSql = " OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY ";
        }

        const fullSqlQuery = `
            SELECT * INTO #TempBatches FROM (
                ${rawUnionSql}
            ) AS U;

            SELECT *,
                CASE
                    WHEN ExpiryDate < CAST(GETDATE() AS DATE) THEN 'EXPIRED'
                    WHEN DaysToExpiry <= 30 THEN '0-30'
                    WHEN DaysToExpiry <= 60 THEN '31-60'
                    WHEN DaysToExpiry <= 90 THEN '61-90'
                    WHEN DaysToExpiry <= 180 THEN '91-180'
                    ELSE '180+'
                END AS AgingBucket
            INTO #BaseFiltered
            FROM #TempBatches
            WHERE 1=1 ${searchCondition};

            SELECT * INTO #BucketFiltered
            FROM #BaseFiltered
            WHERE 1=1 ${bucketCondition};

            -- Result 0: Summary per Aging Bucket (from #BaseFiltered)
            SELECT 
                AgingBucket,
                COUNT(*) AS ItemCount,
                COUNT(CASE WHEN TrackingType = 'Batch' THEN 1 END) AS BatchCount,
                COUNT(CASE WHEN TrackingType = 'Serial' THEN 1 END) AS SerialCount,
                ISNULL(SUM(StockQty), 0) AS TotalStockQty,
                ISNULL(SUM(StockValue), 0) AS TotalStockValue
            FROM #BaseFiltered
            GROUP BY AgingBucket;

            -- Result 1: Total records matching current search + bucket filters
            SELECT COUNT(*) AS totalRecords FROM #BucketFiltered;

            -- Result 2: Paginated/All items
            SELECT 
                Company,
                TrackingType,
                ItemCode,
                ItemName,
                FrgnName,
                Category,
                BatchNumber,
                ExpiryDate,
                DaysToExpiry,
                AgingBucket,
                CASE
                    WHEN AgingBucket = 'EXPIRED' THEN 'Expired'
                    WHEN AgingBucket = '0-30' THEN '0-30 Days'
                    WHEN AgingBucket = '31-60' THEN '31-60 Days'
                    WHEN AgingBucket = '61-90' THEN '61-90 Days'
                    WHEN AgingBucket = '91-180' THEN '91-180 Days'
                    ELSE '180+ Days'
                END AS ExpiryAging,
                StockQty,
                UnitPrice,
                StockValue
            FROM #BucketFiltered
            ORDER BY ${sortCol} ${sortOrder}, ItemCode ASC
            ${paginationSql};

            -- Result 3: Full-database Category Risk & Aging Aggregation (from #BaseFiltered)
            SELECT 
                ISNULL(NULLIF(LTRIM(RTRIM(Category)), ''), 'Uncategorized') AS Category,
                COUNT(*) AS TotalLots,
                COUNT(CASE WHEN TrackingType = 'Batch' THEN 1 END) AS BatchCount,
                COUNT(CASE WHEN TrackingType = 'Serial' THEN 1 END) AS SerialCount,
                ISNULL(SUM(StockQty), 0) AS TotalStockQty,
                ISNULL(SUM(StockValue), 0) AS TotalCategoryValue,
                ISNULL(SUM(CASE WHEN AgingBucket = 'EXPIRED' THEN StockQty ELSE 0 END), 0) AS ExpiredQty,
                ISNULL(SUM(CASE WHEN AgingBucket = 'EXPIRED' THEN StockValue ELSE 0 END), 0) AS ExpiredValue,
                ISNULL(SUM(CASE WHEN AgingBucket = '0-30' THEN StockQty ELSE 0 END), 0) AS Days0To30Qty,
                ISNULL(SUM(CASE WHEN AgingBucket = '0-30' THEN StockValue ELSE 0 END), 0) AS Days0To30Value,
                ISNULL(SUM(CASE WHEN AgingBucket = '31-60' THEN StockQty ELSE 0 END), 0) AS Days31To60Qty,
                ISNULL(SUM(CASE WHEN AgingBucket = '31-60' THEN StockValue ELSE 0 END), 0) AS Days31To60Value,
                ISNULL(SUM(CASE WHEN AgingBucket = '61-90' THEN StockQty ELSE 0 END), 0) AS Days61To90Qty,
                ISNULL(SUM(CASE WHEN AgingBucket = '61-90' THEN StockValue ELSE 0 END), 0) AS Days61To90Value,
                ISNULL(SUM(CASE WHEN AgingBucket = '91-180' THEN StockQty ELSE 0 END), 0) AS Days91To180Qty,
                ISNULL(SUM(CASE WHEN AgingBucket = '91-180' THEN StockValue ELSE 0 END), 0) AS Days91To180Value,
                ISNULL(SUM(CASE WHEN AgingBucket = '180+' THEN StockQty ELSE 0 END), 0) AS Days180PlusQty,
                ISNULL(SUM(CASE WHEN AgingBucket = '180+' THEN StockValue ELSE 0 END), 0) AS Days180PlusValue,
                ISNULL(SUM(CASE WHEN AgingBucket IN ('EXPIRED', '0-30', '31-60', '61-90', '91-180') THEN StockQty ELSE 0 END), 0) AS TotalRiskStockQty,
                ISNULL(SUM(CASE WHEN AgingBucket IN ('EXPIRED', '0-30', '31-60', '61-90', '91-180') THEN StockValue ELSE 0 END), 0) AS TotalRiskValue
            FROM #BaseFiltered
            GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(Category)), ''), 'Uncategorized')
            ORDER BY TotalRiskStockQty DESC, TotalStockQty DESC;

            DROP TABLE #TempBatches;
            DROP TABLE #BaseFiltered;
            DROP TABLE #BucketFiltered;
        `;

        const result = await request.query(fullSqlQuery);

        const rawSummary = result.recordsets[0] || [];
        const totalRecords = result.recordsets[1]?.[0]?.totalRecords || 0;
        const items = result.recordsets[2] || [];
        const categorySummary = result.recordsets[3] || [];

        // Build structured summary dictionary
        const summaryBuckets = {
            'EXPIRED': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            '0-30': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            '31-60': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            '61-90': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            '91-180': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            '180+': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 },
            'ALL': { count: 0, batchCount: 0, serialCount: 0, stockQty: 0, stockValue: 0 }
        };

        rawSummary.forEach(row => {
            if (summaryBuckets[row.AgingBucket]) {
                summaryBuckets[row.AgingBucket].count = row.ItemCount;
                summaryBuckets[row.AgingBucket].batchCount = row.BatchCount || 0;
                summaryBuckets[row.AgingBucket].serialCount = row.SerialCount || 0;
                summaryBuckets[row.AgingBucket].stockQty = row.TotalStockQty;
                summaryBuckets[row.AgingBucket].stockValue = row.TotalStockValue || 0;
            }
            summaryBuckets['ALL'].count += row.ItemCount;
            summaryBuckets['ALL'].batchCount += (row.BatchCount || 0);
            summaryBuckets['ALL'].serialCount += (row.SerialCount || 0);
            summaryBuckets['ALL'].stockQty += row.TotalStockQty;
            summaryBuckets['ALL'].stockValue += (row.TotalStockValue || 0);
        });

        return {
            shortExpiryItemsTable: items,
            lowStockItemsTable: items,
            recentItemsTable: items,
            totalRecords,
            page: pagination.page || 1,
            limit: pagination.limit || 0,
            totalPages: pagination.limit > 0 ? Math.ceil(totalRecords / pagination.limit) : 1,
            summaryBuckets,
            categorySummary
        };
    }

    static async getInventoryDashboardCards(filters) {
        const pool = await poolPromise;
        const request = pool.request();

        const filterSqlT0 = this.applyFilters(filters, request, 'T0.');
        const filterSqlOITM = this.applyFilters(filters, request, 'OITM.');

        let warehouseFilterGMS = filters.warehouse ? " INNER JOIN gms_live.dbo.OITW W ON OITM.ItemCode = W.ItemCode AND W.WhsCode = @warehouse " : "";
        let warehouseFilterLDS = filters.warehouse ? " INNER JOIN lds_live.dbo.OITW W ON OITM.ItemCode = W.ItemCode AND W.WhsCode = @warehouse " : "";
        if (filters.warehouse && !request.parameters.warehouse) {
            request.input('warehouse', sql.VarChar, filters.warehouse);
        }

        // Totals queries (Card 1,2,3,4,5)
        // Goods Issued & Received: For simplicity, keeping simple COUNT if no item filters, otherwise we would need JOINs.
        // Assuming user approved to keep it simple, we just apply FiscalYear to these headers.
        let docFilter = "";
        if (filters.fiscalYear) {
            const [startYear, endYear] = filters.fiscalYear.split('-');
            if (startYear && endYear) {
                docFilter += ` AND DocDate >= @fyStart AND DocDate < @fyEnd `;
                if (!request.parameters.fyStart) {
                    request.input('fyStart', sql.Date, new Date(`${startYear}-07-01`));
                    request.input('fyEnd', sql.Date, new Date(`${endYear}-07-01`));
                }
            }
        }

        let kpiQueries = [];
        kpiQueries.push(`
            SELECT 
                (SELECT COUNT(*) FROM lds_live.dbo.OIGE WHERE 1=1 ${docFilter} ${filters.company === 'GMS' ? 'AND 1=0' : ''}) AS LdsGoodsIssued,
                (SELECT COUNT(*) FROM gms_live.dbo.OIGE WHERE 1=1 ${docFilter} ${filters.company === 'LDS' ? 'AND 1=0' : ''}) AS GmsGoodsIssued,
                
                (SELECT COUNT(*) FROM lds_live.dbo.OIGN WHERE 1=1 ${docFilter} ${filters.company === 'GMS' ? 'AND 1=0' : ''}) AS LdsGoodsReceived,
                (SELECT COUNT(*) FROM gms_live.dbo.OIGN WHERE 1=1 ${docFilter} ${filters.company === 'LDS' ? 'AND 1=0' : ''}) AS GmsGoodsReceived,
                
                (SELECT COUNT(*) FROM (
                    ${(!filters.company || filters.company === 'GMS') ? `SELECT ItemCode FROM gms_live.dbo.OITM ${warehouseFilterGMS} WHERE FrozenFor = 'N' ${filterSqlOITM}` : ''}
                    ${(!filters.company) ? ' UNION ALL ' : ''}
                    ${(!filters.company || filters.company === 'LDS') ? `SELECT ItemCode FROM lds_live.dbo.OITM ${warehouseFilterLDS} WHERE FrozenFor = 'N' ${filterSqlOITM}` : ''}
                ) AS ActiveItems) AS TotalActiveItems,
                
                (SELECT COUNT(DISTINCT ItmsGrpCod) FROM (
                    ${(!filters.company || filters.company === 'GMS') ? `SELECT ItmsGrpCod FROM gms_live.dbo.OITM ${warehouseFilterGMS} WHERE FrozenFor = 'N' ${filterSqlOITM}` : ''}
                    ${(!filters.company) ? ' UNION ' : ''}
                    ${(!filters.company || filters.company === 'LDS') ? `SELECT ItmsGrpCod FROM lds_live.dbo.OITM ${warehouseFilterLDS} WHERE FrozenFor = 'N' ${filterSqlOITM}` : ''}
                ) AS Grps) AS TotalItemGroups,

                (SELECT COUNT(DISTINCT Category) FROM (
                    ${(!filters.company || filters.company === 'GMS') ? `SELECT U_Cat1 AS Category FROM gms_live.dbo.OITM ${warehouseFilterGMS} WHERE FrozenFor = 'N' AND U_Cat1 IS NOT NULL AND LTRIM(RTRIM(U_Cat1)) <> '' ${filterSqlOITM}` : ''}
                    ${(!filters.company) ? ' UNION ' : ''}
                    ${(!filters.company || filters.company === 'LDS') ? `SELECT U_Cat1 AS Category FROM lds_live.dbo.OITM ${warehouseFilterLDS} WHERE FrozenFor = 'N' AND U_Cat1 IS NOT NULL AND LTRIM(RTRIM(U_Cat1)) <> '' ${filterSqlOITM}` : ''}
                ) AS Cats) AS TotalCategories,

                (SELECT COUNT(*) FROM (
                    ${(!filters.company || filters.company === 'GMS') ? `SELECT WhsCode FROM gms_live.dbo.OWHS WHERE 1=1 ${filters.warehouse ? 'AND WhsCode=@warehouse' : ''}` : ''}
                    ${(!filters.company) ? ' UNION ALL ' : ''}
                    ${(!filters.company || filters.company === 'LDS') ? `SELECT WhsCode FROM lds_live.dbo.OWHS WHERE 1=1 ${filters.warehouse ? 'AND WhsCode=@warehouse' : ''}` : ''}
                ) AS Whss) AS TotalWarehouses
        `);

        // Categories query
        let catQueries = [];
        if (!filters.company || filters.company === 'GMS') {
            catQueries.push(`SELECT 'GMS' AS Company, OITM.U_Cat1 AS Category, COUNT(*) AS ActiveItems FROM gms_live.dbo.OITM ${warehouseFilterGMS} WHERE OITM.FrozenFor = 'N' ${filterSqlOITM} GROUP BY OITM.U_Cat1`);
        }
        if (!filters.company || filters.company === 'LDS') {
            catQueries.push(`SELECT 'LDS' AS Company, OITM.U_Cat1 AS Category, COUNT(*) AS ActiveItems FROM lds_live.dbo.OITM ${warehouseFilterLDS} WHERE OITM.FrozenFor = 'N' ${filterSqlOITM} GROUP BY OITM.U_Cat1`);
        }

        // Groups query
        let grpQueries = [];
        if (!filters.company || filters.company === 'GMS') {
            grpQueries.push(`SELECT 'GMS' AS Company, T1.ItmsGrpCod, T1.ItmsGrpNam, COUNT(*) AS ActiveItems FROM gms_live.dbo.OITM T0 INNER JOIN gms_live.dbo.OITB T1 ON T0.ItmsGrpCod = T1.ItmsGrpCod ${warehouseFilterGMS.replace('OITM.','T0.')} WHERE T0.FrozenFor = 'N' ${filterSqlT0} GROUP BY T1.ItmsGrpCod, T1.ItmsGrpNam`);
        }
        if (!filters.company || filters.company === 'LDS') {
            grpQueries.push(`SELECT 'LDS' AS Company, T1.ItmsGrpCod, T1.ItmsGrpNam, COUNT(*) AS ActiveItems FROM lds_live.dbo.OITM T0 INNER JOIN lds_live.dbo.OITB T1 ON T0.ItmsGrpCod = T1.ItmsGrpCod ${warehouseFilterLDS.replace('OITM.','T0.')} WHERE T0.FrozenFor = 'N' ${filterSqlT0} GROUP BY T1.ItmsGrpCod, T1.ItmsGrpNam`);
        }

        // Warehouses query
        let whsQueries = [];
        if (!filters.company || filters.company === 'GMS') {
            whsQueries.push(`SELECT 'GMS' AS Company, T0.WhsCode, T0.WhsName, COUNT(DISTINCT T1.ItemCode) AS ActiveItemCount FROM gms_live.dbo.OWHS T0 INNER JOIN gms_live.dbo.OITW T1 ON T0.WhsCode = T1.WhsCode INNER JOIN gms_live.dbo.OITM T2 ON T1.ItemCode = T2.ItemCode WHERE T2.FrozenFor = 'N' AND T1.OnHand > 0 ${filterSqlT0.replace('T0.','T2.')} ${filters.warehouse ? 'AND T0.WhsCode=@warehouse' : ''} GROUP BY T0.WhsCode, T0.WhsName`);
        }
        if (!filters.company || filters.company === 'LDS') {
            whsQueries.push(`SELECT 'LDS' AS Company, T0.WhsCode, T0.WhsName, COUNT(DISTINCT T1.ItemCode) AS ActiveItemCount FROM lds_live.dbo.OWHS T0 INNER JOIN lds_live.dbo.OITW T1 ON T0.WhsCode = T1.WhsCode INNER JOIN lds_live.dbo.OITM T2 ON T1.ItemCode = T2.ItemCode WHERE T2.FrozenFor = 'N' AND T1.OnHand > 0 ${filterSqlT0.replace('T0.','T2.')} ${filters.warehouse ? 'AND T0.WhsCode=@warehouse' : ''} GROUP BY T0.WhsCode, T0.WhsName`);
        }

        let fullQuery = `
            ${kpiQueries.join("")};
            ${catQueries.join(" UNION ALL ")} ORDER BY ActiveItems DESC;
            ${grpQueries.join(" UNION ALL ")} ORDER BY ActiveItems DESC;
            ${whsQueries.join(" UNION ALL ")} ORDER BY ActiveItemCount DESC;
        `;

        const result = await request.query(fullQuery);
        
        let kpiTotals = result.recordsets[0] ? result.recordsets[0][0] : {};
        kpiTotals.TotalGoodsIssued = (kpiTotals.LdsGoodsIssued || 0) + (kpiTotals.GmsGoodsIssued || 0);
        kpiTotals.TotalGoodsReceived = (kpiTotals.LdsGoodsReceived || 0) + (kpiTotals.GmsGoodsReceived || 0);

        const dashboardData = {
            kpiTotals: kpiTotals,
            categories: result.recordsets[1] || [],
            groups: result.recordsets[2] || [],
            warehouses: result.recordsets[3] || []
        };
        
        return dashboardData;
    }

    static async getInventoryItems(pagination, sorting, filters, search) {
        const pool = await poolPromise;
        const request = pool.request();
        
        const filterSql = this.applyFilters(filters, request, 'OITM.');
        let warehouseFilterGMS = filters.warehouse ? " INNER JOIN gms_live.dbo.OITW W ON OITM.ItemCode = W.ItemCode AND W.WhsCode = @warehouse " : "";
        let warehouseFilterLDS = filters.warehouse ? " INNER JOIN lds_live.dbo.OITW W ON OITM.ItemCode = W.ItemCode AND W.WhsCode = @warehouse " : "";
        if (filters.warehouse && !request.parameters.warehouse) {
            request.input('warehouse', sql.VarChar, filters.warehouse);
        }

        let searchSql = "";
        if (search) {
            searchSql = ` AND (OITM.ItemCode LIKE @search OR OITM.ItemName LIKE @search OR OITM.FrgnName LIKE @search OR OITM.CodeBars LIKE @search) `;
            request.input('search', sql.VarChar, `%${search}%`);
        }

        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        // Select heavy columns for Item Master
        let queries = [];
        if (!filters.company || filters.company === 'GMS') {
            queries.push(`SELECT 'GMS' AS Company, OITM.ItemCode AS ItemCode, OITM.ItemName AS ItemName, OITM.FrgnName AS FrgnName, OITM.ItmsGrpCod AS ItemGroup, OITM.U_Cat1 AS Category, OITM.CodeBars AS Barcode, OITM.CardCode AS Supplier, OITM.CreateDate AS CreatedDate, OITM.DfltWH AS DefaultWarehouse, OITM.ManBtchNum AS BatchTracked, OITM.ManSerNum AS SerialTracked, OITM.OnHand AS Stock, OITM.AvgPrice AS Price, OITM.LstEvlPric AS LstEvlPric, OITM.U_Division AS BusinessSegment, P1.CardName AS Principal, T1.IncreasAc AS GoodsReceiptAcctCode, A1.AcctName AS GoodsReceiptAcctName, T1.DecreasAc AS GoodsIssueAcctCode, A2.AcctName AS GoodsIssueAcctName FROM gms_live.dbo.OITM INNER JOIN gms_live.dbo.OITB T1 ON OITM.ItmsGrpCod = T1.ItmsGrpCod LEFT JOIN gms_live.dbo.OACT A1 ON T1.IncreasAc = A1.AcctCode LEFT JOIN gms_live.dbo.OACT A2 ON T1.DecreasAc = A2.AcctCode LEFT JOIN gms_live.dbo.OCRD P1 ON OITM.CardCode = P1.CardCode ${warehouseFilterGMS} WHERE 1=1 AND OITM.FrozenFor = 'N' ${filters.hideZeroQty ? 'AND OITM.OnHand > 0' : ''} ${filterSql} ${searchSql}`);
        }
        if (!filters.company || filters.company === 'LDS') {
            queries.push(`SELECT 'LDS' AS Company, OITM.ItemCode AS ItemCode, OITM.ItemName AS ItemName, OITM.FrgnName AS FrgnName, OITM.ItmsGrpCod AS ItemGroup, OITM.U_Cat1 AS Category, OITM.CodeBars AS Barcode, OITM.CardCode AS Supplier, OITM.CreateDate AS CreatedDate, OITM.DfltWH AS DefaultWarehouse, OITM.ManBtchNum AS BatchTracked, OITM.ManSerNum AS SerialTracked, OITM.OnHand AS Stock, OITM.AvgPrice AS Price, OITM.LstEvlPric AS LstEvlPric, OITM.U_Division AS BusinessSegment, P1.CardName AS Principal, T1.IncreasAc AS GoodsReceiptAcctCode, A1.AcctName AS GoodsReceiptAcctName, T1.DecreasAc AS GoodsIssueAcctCode, A2.AcctName AS GoodsIssueAcctName FROM lds_live.dbo.OITM INNER JOIN lds_live.dbo.OITB T1 ON OITM.ItmsGrpCod = T1.ItmsGrpCod LEFT JOIN lds_live.dbo.OACT A1 ON T1.IncreasAc = A1.AcctCode LEFT JOIN lds_live.dbo.OACT A2 ON T1.DecreasAc = A2.AcctCode LEFT JOIN lds_live.dbo.OCRD P1 ON OITM.CardCode = P1.CardCode ${warehouseFilterLDS} WHERE 1=1 AND OITM.FrozenFor = 'N' ${filters.hideZeroQty ? 'AND OITM.OnHand > 0' : ''} ${filterSql} ${searchSql}`);
        }

        let finalQuery = queries.join(" UNION ALL ");
        
        // Count Query for pagination
        let countQuery = `SELECT COUNT(*) AS total FROM (${finalQuery}) AS CountTable;`;
        
        // Sorting and Pagination
        finalQuery += ` ORDER BY ${sorting.sortBy} ${sorting.sortOrder} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

        const countResult = await request.query(countQuery);
        const result = await request.query(finalQuery);

        return {
            items: result.recordsets[0] || [],
            total: countResult.recordset[0].total
        };
    }

    static async getNextDocNum(type, company) {
        const pool = await poolPromise;
        const dbPrefix = company === 'LDS' ? 'lds_live' : 'gms_live';
        const request = pool.request();
        const table = type === 'goods-issue' ? 'OIGE' : 'OIGN';
        const result = await request.query(`SELECT ISNULL(MAX(DocNum), 0) + 1 AS nextDocNum FROM ${dbPrefix}.dbo.${table};`);
        return result.recordset[0]?.nextDocNum || 1;
    }

    static async getItemHistory(itemCode, company, filters = {}) {
        const pool = await poolPromise;
        let dbName = company === 'LDS' ? 'lds_live.dbo' : 'gms_live.dbo';

        // 1. Fetch item metadata
        const metaRequest = pool.request();
        metaRequest.input('itemCode', sql.VarChar, itemCode);
        const metaQuery = `
            SELECT 
                T0.ItemCode,
                T0.ItemName,
                T0.FrgnName,
                T0.U_Cat1 AS Category,
                T0.CodeBars AS Barcode,
                ISNULL(T1.CardName, '') AS Principal,
                ISNULL(T0.U_Division, '') AS BusinessSegment,
                CASE 
                    WHEN T0.ManBtchNum = 'Y' THEN 'Batch'
                    WHEN T0.ManSerNum = 'Y' THEN 'Serial'
                    ELSE 'None'
                END AS TrackingType
            FROM ${dbName}.OITM T0
            LEFT JOIN ${dbName}.OCRD T1 ON T0.CardCode = T1.CardCode
            WHERE T0.ItemCode = @itemCode;
        `;
        const metaResult = await metaRequest.query(metaQuery);
        const meta = metaResult.recordset[0] || {};

        // 2. Fetch Inventory Audit Report using OINM
        const historyRequest = pool.request();
        historyRequest.input('itemCode', sql.VarChar, itemCode);
        
        let dateFilter = '';
        if (filters.startDate && filters.endDate) {
            dateFilter = ' AND TransactionDate >= @startDate AND TransactionDate < DATEADD(day, 1, @endDate) ';
            historyRequest.input('startDate', sql.Date, filters.startDate);
            historyRequest.input('endDate', sql.Date, filters.endDate);
        }

        const historyQuery = `
            WITH BaseData AS (
                SELECT 
                    T0.ItemCode,
                    T1.ItemName,
                    T0.Warehouse AS WarehouseCode,
                    ISNULL(W.WhsName, T0.Warehouse) AS WarehouseName,
                    T1.OnHand AS CurrentStock,
                    T0.TransType AS TransactionType,
                    (SELECT [Name] FROM ${dbName}.[@SAPTRANS] a WHERE a.Code = T0.TransType) AS [TransactionName],
                    T0.CreateDate AS TransactionDate,
                    ISNULL(T0.DocTime, 0) AS TransactionTime,
                    T0.TransNum AS TransactionSeq,
                    T0.Base_Ref AS DocumentNumber,
                    T0.InQty AS IncomingQty,
                    T0.OutQty AS OutgoingQty,
                    T0.Price AS PricePerUnit,
                    (T0.InQty - T0.OutQty) AS NetMovement,
                    (T0.InQty - T0.OutQty) * T0.Price AS TotalValue,
                    ROW_NUMBER() OVER (ORDER BY T0.CreateDate ASC, ISNULL(T0.DocTime, 0) ASC, T0.TransNum ASC) AS RowNum
                FROM ${dbName}.OINM T0
                JOIN ${dbName}.OITM T1 ON T0.ItemCode = T1.ItemCode
                LEFT JOIN ${dbName}.OWHS W ON T0.Warehouse = W.WhsCode
                WHERE T0.ItemCode = @itemCode
            ),
            CalculatedData AS (
                SELECT 
                    ItemCode,
                    ItemName,
                    WarehouseCode,
                    WarehouseName,
                    WarehouseCode AS Warehouse,
                    TransactionType,
                    TransactionName,
                    TransactionDate,
                    TransactionTime,
                    TransactionSeq,
                    DocumentNumber,
                    IncomingQty,
                    OutgoingQty,
                    PricePerUnit,
                    NetMovement,
                    TotalValue,
                    CurrentStock - SUM(NetMovement) OVER (ORDER BY TransactionDate ASC, TransactionTime ASC, TransactionSeq ASC, RowNum ASC ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) + NetMovement AS StockLeft
                FROM BaseData
            )
            SELECT * FROM CalculatedData
            WHERE 1=1 ${dateFilter}
            ORDER BY TransactionDate DESC, TransactionTime DESC, TransactionSeq DESC;
        `;

        const historyResult = await historyRequest.query(historyQuery);
        const history = historyResult.recordset || [];

        return {
            trackingType: meta.TrackingType || 'None',
            itemCode,
            itemName: meta.ItemName || (history[0]?.ItemName) || '',
            principal: meta.Principal || '',
            businessSegment: meta.BusinessSegment || '',
            category: meta.Category || '',
            frgnName: meta.FrgnName || '',
            barcode: meta.Barcode || '',
            history
        };
    }

    static async getItemWarehouses(itemCode, company) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('itemCode', sql.VarChar, itemCode);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    W.WhsCode AS WarehouseCode,
                    WH.WhsName AS WarehouseName,
                    W.OnHand AS InStock,
                    W.IsCommited AS Committed,
                    W.OnOrder AS Ordered,
                    (W.OnHand - W.IsCommited + W.OnOrder) AS Available
                FROM 
                    gms_live.dbo.OITW W
                INNER JOIN 
                    gms_live.dbo.OWHS WH ON W.WhsCode = WH.WhsCode
                WHERE 
                    W.ItemCode = @itemCode 
                    AND (W.OnHand > 0 OR W.IsCommited > 0 OR W.OnOrder > 0)
            `);
        }
        if (!company || company === 'LDS') {
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    W.WhsCode AS WarehouseCode,
                    WH.WhsName AS WarehouseName,
                    W.OnHand AS InStock,
                    W.IsCommited AS Committed,
                    W.OnOrder AS Ordered,
                    (W.OnHand - W.IsCommited + W.OnOrder) AS Available
                FROM 
                    lds_live.dbo.OITW W
                INNER JOIN 
                    lds_live.dbo.OWHS WH ON W.WhsCode = WH.WhsCode
                WHERE 
                    W.ItemCode = @itemCode 
                    AND (W.OnHand > 0 OR W.IsCommited > 0 OR W.OnOrder > 0)
            `);
        }

        let finalQuery = queries.join(" UNION ALL ");
        const result = await request.query(finalQuery);

        return result.recordsets[0] || [];
    }

    // ═══════════════════════════════════════════════════════════
    // GOODS RECEIPT — Create, List, GetById
    // ═══════════════════════════════════════════════════════════

    static async createGoodsReceipt(data, userId) {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();
            const request = new sql.Request(transaction);

            // 1. Insert Header
            request.input('company', sql.VarChar, data.company);
            request.input('cardCode', sql.VarChar, data.cardCode || null);
            request.input('cardName', sql.NVarChar, data.cardName || null);
            request.input('docDate', sql.Date, data.docDate);
            request.input('postingDate', sql.Date, data.postingDate);
            request.input('taxDate', sql.Date, data.taxDate || data.postingDate);
            request.input('remarks', sql.NVarChar, data.remarks || null);
            request.input('createdBy', sql.Int, userId);

            const headerResult = await request.query(`
                INSERT INTO wms.dbo.WMS_GoodsReceipt_Header 
                    (Company, CardCode, CardName, DocDate, PostingDate, TaxDate, Remarks, CreatedBy)
                VALUES 
                    (@company, @cardCode, @cardName, @docDate, @postingDate, @taxDate, @remarks, @createdBy);
                SELECT SCOPE_IDENTITY() AS DocEntry;
            `);

            const docEntry = headerResult.recordset[0].DocEntry;

            // 2. Insert Lines
            for (let i = 0; i < data.lines.length; i++) {
                const line = data.lines[i];
                const lineReq = new sql.Request(transaction);
                lineReq.input('docEntry', sql.Int, docEntry);
                lineReq.input('lineNum', sql.Int, i);
                lineReq.input('itemCode', sql.VarChar, line.itemCode);
                lineReq.input('itemName', sql.NVarChar, line.itemName || null);
                lineReq.input('quantity', sql.Decimal(19, 6), line.quantity);
                lineReq.input('unitPrice', sql.Decimal(19, 6), line.unitPrice || 0);
                lineReq.input('lineTotal', sql.Decimal(19, 6), (line.quantity || 0) * (line.unitPrice || 0));
                lineReq.input('whsCode', sql.VarChar, line.whsCode);
                lineReq.input('accountCode', sql.VarChar, line.accountCode || null);
                lineReq.input('taxCode', sql.VarChar, line.taxCode || null);

                await lineReq.query(`
                    INSERT INTO wms.dbo.WMS_GoodsReceipt_Lines 
                        (DocEntry, LineNum, ItemCode, ItemName, Quantity, UnitPrice, LineTotal, WhsCode, AccountCode, TaxCode)
                    VALUES 
                        (@docEntry, @lineNum, @itemCode, @itemName, @quantity, @unitPrice, @lineTotal, @whsCode, @accountCode, @taxCode);
                `);
            }

            // 3. Update DocTotal on Header
            const totalReq = new sql.Request(transaction);
            totalReq.input('docEntry', sql.Int, docEntry);
            await totalReq.query(`
                UPDATE wms.dbo.WMS_GoodsReceipt_Header 
                SET DocTotal = (SELECT ISNULL(SUM(LineTotal), 0) FROM wms.dbo.WMS_GoodsReceipt_Lines WHERE DocEntry = @docEntry)
                WHERE DocEntry = @docEntry;
            `);

            // 4. Generate DocNum
            const numReq = new sql.Request(transaction);
            numReq.input('docEntry', sql.Int, docEntry);
            await numReq.query(`
                UPDATE wms.dbo.WMS_GoodsReceipt_Header 
                SET DocNum = CONCAT('WMS-GR-', RIGHT('00000' + CAST(@docEntry AS VARCHAR), 5))
                WHERE DocEntry = @docEntry;
            `);

            await transaction.commit();
            return { docEntry, docNum: `WMS-GR-${String(docEntry).padStart(5, '0')}` };
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    static async getGoodsReceipts(pagination, sorting, filters) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = filters.search ? `%${filters.search}%` : null;
        if (searchVal) request.input('search', sql.VarChar, searchVal);
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        const buildQuery = (company) => `
            SELECT '${company}' AS Company, DocEntry, DocNum, CardCode, CardName, DocDate, TaxDate AS PostingDate, 
                   DocTotal, CASE WHEN CANCELED = 'Y' THEN 'Canceled' ELSE 'Posted' END AS Status,
                   1 AS IsSynced, CreateDate AS CreatedAt
            FROM ${company.toLowerCase()}_live.dbo.OIGN
            WHERE 1=1
            ${searchVal ? 'AND (DocNum LIKE @search OR CardName LIKE @search OR CardCode LIKE @search)' : ''}
        `;

        let queries = [];
        if (!filters.company || filters.company === 'GMS') queries.push(buildQuery('GMS'));
        if (!filters.company || filters.company === 'LDS') queries.push(buildQuery('LDS'));

        const unionQuery = queries.join(" UNION ALL ");

        // For SAP B1 tables, sort columns might differ. Default to DocEntry descending.
        const sortCol = sorting.sortBy === 'CreatedAt' ? 'DocEntry' : sorting.sortBy;
        
        const countResult = await request.query(`SELECT COUNT(*) AS total FROM (${unionQuery}) AS T;`);
        const dataResult = await request.query(`
            ${unionQuery}
            ORDER BY ${sortCol} ${sorting.sortOrder}
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

        return {
            items: dataResult.recordset || [],
            total: countResult.recordset[0].total
        };
    }

    static async getGoodsReceiptById(docEntry, company) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('docEntry', sql.Int, docEntry);

        if (company) {
            const db = company.toLowerCase() + '_live';
            const header = await request.query(`
                SELECT '${company}' AS Company, DocEntry, DocNum, CardCode, CardName, DocDate, TaxDate AS PostingDate, 
                       DocTotal, CASE WHEN CANCELED = 'Y' THEN 'Canceled' ELSE 'Posted' END AS Status
                FROM ${db}.dbo.OIGN WHERE DocEntry = @docEntry;
            `);
            if (!header.recordset[0]) return null;

            const lines = await request.query(`
                SELECT L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.Price AS UnitPrice, L.LineTotal, L.WhsCode, L.AcctCode AS AccountCode, A.AcctName AS AccountName, L.LineNum
                FROM ${db}.dbo.IGN1 L
                LEFT JOIN ${db}.dbo.OACT A ON L.AcctCode = A.AcctCode
                WHERE L.DocEntry = @docEntry ORDER BY L.LineNum;
            `);

            const batches = await request.query(`
                SELECT 
                    T0.BaseLinNum AS LineNum,
                    T0.BatchNum, 
                    T0.Quantity, 
                    T0.WhsCode,
                    CAST(T1.MnfDate AS DATE) AS MnfDate,
                    CAST(T1.ExpDate AS DATE) AS ExpDate
                FROM ${db}.dbo.IBT1 T0
                INNER JOIN ${db}.dbo.OBTN T1 ON T0.ItemCode = T1.ItemCode AND T0.BatchNum = T1.DistNumber
                WHERE T0.BaseType = 59 AND T0.BaseEntry = @docEntry AND T0.Direction = 0;
            `);

            const serials = await request.query(`
                SELECT S.BaseLinNum AS LineNum, S.SysSerial, O.SuppSerial, 1 AS Quantity, S.WhsCode, CAST(O.PrdDate AS DATE) AS MnfDate, CAST(O.ExpDate AS DATE) AS ExpDate
                FROM ${db}.dbo.SRI1 S
                LEFT JOIN ${db}.dbo.OSRI O ON S.ItemCode = O.ItemCode AND S.SysSerial = O.SysSerial
                WHERE S.BaseType = 59 AND S.BaseEntry = @docEntry AND S.Direction = 0;
            `);

            const processedLines = (lines.recordset || []).map(line => ({
                ...line,
                batches: (batches.recordset || []).filter(b => b.LineNum === line.LineNum),
                serials: (serials.recordset || []).filter(s => s.LineNum === line.LineNum)
            }));

            return {
                header: header.recordset[0],
                lines: processedLines
            };
        } else {
            const header = await request.query(`
                SELECT * FROM wms.dbo.WMS_GoodsReceipt_Header WHERE DocEntry = @docEntry;
            `);

            const lines = await request.query(`
                SELECT * FROM wms.dbo.WMS_GoodsReceipt_Lines WHERE DocEntry = @docEntry ORDER BY LineNum;
            `);

            if (!header.recordset[0]) return null;

            return {
                header: header.recordset[0],
                lines: lines.recordset || []
            };
        }
    }

    // ═══════════════════════════════════════════════════════════
    // GOODS ISSUE — Create, List, GetById
    // ═══════════════════════════════════════════════════════════


    static async getGoodsIssues(pagination, sorting, filters) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = filters.search ? `%${filters.search}%` : null;
        if (searchVal) request.input('search', sql.VarChar, searchVal);
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        const buildQuery = (company) => `
            SELECT '${company}' AS Company, DocEntry, DocNum, DocDate, TaxDate AS PostingDate, 
                   DocTotal, CASE WHEN CANCELED = 'Y' THEN 'Canceled' ELSE 'Posted' END AS Status,
                   1 AS IsSynced, CreateDate AS CreatedAt
            FROM ${company.toLowerCase()}_live.dbo.OIGE
            WHERE 1=1
            ${searchVal ? 'AND (DocNum LIKE @search OR Comments LIKE @search)' : ''}
        `;

        let queries = [];
        if (!filters.company || filters.company === 'GMS') queries.push(buildQuery('GMS'));
        if (!filters.company || filters.company === 'LDS') queries.push(buildQuery('LDS'));

        const unionQuery = queries.join(" UNION ALL ");

        // For SAP B1 tables, sort columns might differ. Default to DocEntry descending.
        const sortCol = sorting.sortBy === 'CreatedAt' ? 'DocEntry' : sorting.sortBy;
        
        const countResult = await request.query(`SELECT COUNT(*) AS total FROM (${unionQuery}) AS T;`);
        const dataResult = await request.query(`
            ${unionQuery}
            ORDER BY ${sortCol} ${sorting.sortOrder}
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

        return {
            items: dataResult.recordset || [],
            total: countResult.recordset[0].total
        };
    }

    static async getGoodsIssueById(docEntry, company) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('docEntry', sql.Int, docEntry);

        if (company) {
            const db = company.toLowerCase() + '_live';
            const header = await request.query(`
                SELECT '${company}' AS Company, DocEntry, DocNum, DocDate, TaxDate AS PostingDate, 
                       DocTotal, CASE WHEN CANCELED = 'Y' THEN 'Canceled' ELSE 'Posted' END AS Status
                FROM ${db}.dbo.OIGE WHERE DocEntry = @docEntry;
            `);
            if (!header.recordset[0]) return null;

            const lines = await request.query(`
                SELECT L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.Price AS UnitPrice, L.LineTotal, L.WhsCode, L.AcctCode AS AccountCode, A.AcctName AS AccountName, L.LineNum
                FROM ${db}.dbo.IGE1 L
                LEFT JOIN ${db}.dbo.OACT A ON L.AcctCode = A.AcctCode
                WHERE L.DocEntry = @docEntry ORDER BY L.LineNum;
            `);

            const batches = await request.query(`
                SELECT 
                    T0.BaseLinNum AS LineNum,
                    T0.BatchNum, 
                    T0.Quantity, 
                    T0.WhsCode,
                    CAST(T1.MnfDate AS DATE) AS MnfDate,
                    CAST(T1.ExpDate AS DATE) AS ExpDate
                FROM ${db}.dbo.IBT1 T0
                INNER JOIN ${db}.dbo.OBTN T1 ON T0.ItemCode = T1.ItemCode AND T0.BatchNum = T1.DistNumber
                WHERE T0.BaseType = 60 AND T0.BaseEntry = @docEntry AND T0.Direction = 1;
            `);

            const serials = await request.query(`
                SELECT S.BaseLinNum AS LineNum, S.SysSerial, O.SuppSerial, 1 AS Quantity, S.WhsCode, CAST(O.PrdDate AS DATE) AS MnfDate, CAST(O.ExpDate AS DATE) AS ExpDate
                FROM ${db}.dbo.SRI1 S
                LEFT JOIN ${db}.dbo.OSRI O ON S.ItemCode = O.ItemCode AND S.SysSerial = O.SysSerial
                WHERE S.BaseType = 60 AND S.BaseEntry = @docEntry AND S.Direction = 1;
            `);

            const processedLines = (lines.recordset || []).map(line => ({
                ...line,
                batches: (batches.recordset || []).filter(b => b.LineNum === line.LineNum),
                serials: (serials.recordset || []).filter(s => s.LineNum === line.LineNum)
            }));

            return {
                header: header.recordset[0],
                lines: processedLines
            };
        } else {
            const header = await request.query(`
                SELECT * FROM wms.dbo.WMS_GoodsIssue_Header WHERE DocEntry = @docEntry;
            `);

            const lines = await request.query(`
                SELECT * FROM wms.dbo.WMS_GoodsIssue_Lines WHERE DocEntry = @docEntry ORDER BY LineNum;
            `);

            if (!header.recordset[0]) return null;

            return {
                header: header.recordset[0],
                lines: lines.recordset || []
            };
        }
    }

    // ═══════════════════════════════════════════════════════════
    // LOOKUP ENDPOINTS — For Choose From List (CFL) modals
    // ═══════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // INVENTORY TRANSFER
    // ═══════════════════════════════════════════════════════════

    static async createInventoryTransfer(data, userId) {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const dbPrefix = data.company === 'GMS' ? 'gms_live' : 'lds_live';

            // 1. Validate stock availability
            for (let i = 0; i < data.lines.length; i++) {
                const line = data.lines[i];
                const stockReq = new sql.Request(transaction);
                stockReq.input('itemCode', sql.VarChar, line.itemCode);
                stockReq.input('whsCode', sql.VarChar, data.fromWhs);

                const stockResult = await stockReq.query(`
                    SELECT ISNULL(OnHand, 0) AS OnHand 
                    FROM ${dbPrefix}.dbo.OITW 
                    WHERE ItemCode = @itemCode AND WhsCode = @whsCode;
                `);

                const available = stockResult.recordset[0]?.OnHand || 0;
                if (line.quantity > available) {
                    await transaction.rollback();
                    const err = new Error(`Insufficient stock for item "${line.itemCode}" in source warehouse "${data.fromWhs}". Available: ${available}, Requested: ${line.quantity}`);
                    err.statusCode = 400;
                    throw err;
                }
            }

            // 2. Insert Header (Mocking OWTR insert for local dev)
            const headerReq = new sql.Request(transaction);
            headerReq.input('docDate', sql.Date, data.docDate || new Date());
            headerReq.input('taxDate', sql.Date, data.taxDate || new Date());
            headerReq.input('filler', sql.VarChar, data.fromWhs);
            headerReq.input('toWhs', sql.VarChar, data.toWhs);
            headerReq.input('cardCode', sql.VarChar, data.cardCode || null);
            headerReq.input('cardName', sql.NVarChar, data.cardName || null);
            headerReq.input('comments', sql.NVarChar, data.comments || null);

            // Note: Since this is local dev we attempt basic insert. In prod, DI API is used.
            const headerResult = await headerReq.query(`
                INSERT INTO ${dbPrefix}.dbo.OWTR 
                    (DocStatus, DocDate, TaxDate, Filler, ToWhsCode, CardCode, CardName, Comments)
                VALUES 
                    ('O', @docDate, @taxDate, @filler, @toWhs, @cardCode, @cardName, @comments);
                SELECT SCOPE_IDENTITY() AS DocEntry;
            `);

            const docEntry = headerResult.recordset[0]?.DocEntry || Math.floor(Math.random() * 100000); // Fallback if no identity

            // 3. Insert Lines (Mocking WTR1)
            for (let i = 0; i < data.lines.length; i++) {
                const line = data.lines[i];
                const lineReq = new sql.Request(transaction);
                lineReq.input('docEntry', sql.Int, docEntry);
                lineReq.input('lineNum', sql.Int, i);
                lineReq.input('itemCode', sql.VarChar, line.itemCode);
                lineReq.input('dscription', sql.NVarChar, line.itemName || null);
                lineReq.input('quantity', sql.Decimal(19, 6), line.quantity);
                lineReq.input('fromWhsCod', sql.VarChar, data.fromWhs);
                lineReq.input('whsCode', sql.VarChar, data.toWhs);

                await lineReq.query(`
                    INSERT INTO ${dbPrefix}.dbo.WTR1 
                        (DocEntry, LineNum, ItemCode, Dscription, Quantity, FromWhsCod, WhsCode)
                    VALUES 
                        (@docEntry, @lineNum, @itemCode, @dscription, @quantity, @fromWhsCod, @whsCode);
                `);

                // 4. Update Stock (OITW) - Source Deduction
                const deductReq = new sql.Request(transaction);
                deductReq.input('itemCode', sql.VarChar, line.itemCode);
                deductReq.input('whsCode', sql.VarChar, data.fromWhs);
                deductReq.input('qty', sql.Decimal(19, 6), line.quantity);
                await deductReq.query(`
                    UPDATE ${dbPrefix}.dbo.OITW 
                    SET OnHand = OnHand - @qty 
                    WHERE ItemCode = @itemCode AND WhsCode = @whsCode;
                `);

                // 5. Update Stock (OITW) - Destination Addition
                const addReq = new sql.Request(transaction);
                addReq.input('itemCode', sql.VarChar, line.itemCode);
                addReq.input('whsCode', sql.VarChar, data.toWhs);
                addReq.input('qty', sql.Decimal(19, 6), line.quantity);
                // Check if destination row exists, else insert (simplified logic)
                await addReq.query(`
                    IF EXISTS (SELECT 1 FROM ${dbPrefix}.dbo.OITW WHERE ItemCode = @itemCode AND WhsCode = @whsCode)
                    BEGIN
                        UPDATE ${dbPrefix}.dbo.OITW SET OnHand = OnHand + @qty WHERE ItemCode = @itemCode AND WhsCode = @whsCode;
                    END
                    ELSE
                    BEGIN
                        INSERT INTO ${dbPrefix}.dbo.OITW (ItemCode, WhsCode, OnHand, IsCommited, OnOrder) VALUES (@itemCode, @whsCode, @qty, 0, 0);
                    END
                `);
            }

            await transaction.commit();
            return { docEntry, docNum: docEntry, status: 'Success' };
        } catch (error) {
            if (transaction._aborted === false) {
                try { await transaction.rollback(); } catch (_) {}
            }
            throw error;
        }
    }

    static async getInventoryTransfers(pagination, sorting, filters) {
        const pool = await poolPromise;
        const request = pool.request();

        let conditions = [];
        if (filters.company === 'GMS' || filters.company === 'LDS') {
            // we will query that specific DB
        }
        
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        // Build dynamically
        let queries = [];
        if (!filters.company || filters.company === 'GMS') {
            queries.push(`SELECT 'GMS' AS Company, DocEntry, DocNum, DocStatus, DocDate, TaxDate, Filler AS FromWhs, ToWhsCode AS ToWhs, CardCode, CardName FROM gms_live.dbo.OWTR`);
        }
        if (!filters.company || filters.company === 'LDS') {
            queries.push(`SELECT 'LDS' AS Company, DocEntry, DocNum, DocStatus, DocDate, TaxDate, Filler AS FromWhs, ToWhsCode AS ToWhs, CardCode, CardName FROM lds_live.dbo.OWTR`);
        }

        const unionQuery = queries.join(" UNION ALL ");
        const countResult = await request.query(`SELECT COUNT(*) AS total FROM (${unionQuery}) AS T;`);
        
        const orderBy = sorting.sortBy || 'DocEntry';
        const orderDir = sorting.sortOrder || 'DESC';
        
        const dataResult = await request.query(`
            SELECT * FROM (${unionQuery}) AS T 
            ORDER BY ${orderBy} ${orderDir} 
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

        return {
            items: dataResult.recordset || [],
            total: countResult.recordset[0].total
        };
    }

    static async getInventoryTransferById(docEntry, company) {
        const pool = await poolPromise;
        const dbPrefix = company === 'GMS' ? 'gms_live' : 'lds_live';
        
        const request = pool.request();
        request.input('docEntry', sql.Int, docEntry);

        const headerResult = await request.query(`
            SELECT DocEntry, DocNum, DocStatus, DocDate, TaxDate, Filler AS FromWhs, ToWhsCode AS ToWhs, CardCode, CardName, Comments
            FROM ${dbPrefix}.dbo.OWTR 
            WHERE DocEntry = @docEntry;
        `);

        if (headerResult.recordset.length === 0) return null;
        const header = headerResult.recordset[0];
        header.Company = company;

        const linesResult = await request.query(`
            SELECT LineNum, ItemCode, Dscription AS ItemName, Quantity, FromWhsCod, WhsCode 
            FROM ${dbPrefix}.dbo.WTR1 
            WHERE DocEntry = @docEntry
            ORDER BY LineNum ASC;
        `);

        const batches = await request.query(`
            SELECT 
                T0.BaseLinNum AS LineNum,
                T0.BatchNum, 
                T0.Quantity, 
                T0.WhsCode,
                CAST(T1.MnfDate AS DATE) AS MnfDate,
                CAST(T1.ExpDate AS DATE) AS ExpDate
            FROM ${dbPrefix}.dbo.IBT1 T0
            INNER JOIN ${dbPrefix}.dbo.OBTN T1 ON T0.ItemCode = T1.ItemCode AND T0.BatchNum = T1.DistNumber
            WHERE T0.BaseType = 67 AND T0.BaseEntry = @docEntry;
        `);

        const serials = await request.query(`
            SELECT S.BaseLinNum AS LineNum, S.SysSerial, O.SuppSerial, 1 AS Quantity, S.WhsCode, CAST(O.PrdDate AS DATE) AS MnfDate, CAST(O.ExpDate AS DATE) AS ExpDate
            FROM ${dbPrefix}.dbo.SRI1 S
            LEFT JOIN ${dbPrefix}.dbo.OSRI O ON S.ItemCode = O.ItemCode AND S.SysSerial = O.SysSerial
            WHERE S.BaseType = 67 AND S.BaseEntry = @docEntry;
        `);

        const processedLines = (linesResult.recordset || []).map(line => ({
            ...line,
            batches: (batches.recordset || []).filter(b => b.LineNum === line.LineNum),
            serials: (serials.recordset || []).filter(s => s.LineNum === line.LineNum)
        }));

        header.lines = processedLines;
        return header;
    }

    // ═══════════════════════════════════════════════════════════
    // DELIVERY CHALLAN
    // ═══════════════════════════════════════════════════════════

    static async getDeliveryChallans(pagination, sorting, filters) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = filters.search ? `%${filters.search}%` : null;
        if (searchVal) request.input('search', sql.VarChar, searchVal);
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        const buildQuery = (company) => `
            SELECT '${company}' AS Company, DocEntry, DocNum, CardCode, CardName, NumAtCard, DocDate, DocTotal, DocStatus, CreateDate AS CreatedAt
            FROM ${company.toLowerCase()}_live.dbo.ODLN
            WHERE 1=1
            ${searchVal ? 'AND (DocNum LIKE @search OR CardName LIKE @search OR CardCode LIKE @search)' : ''}
        `;

        let queries = [];
        if (!filters.company || filters.company === 'GMS') queries.push(buildQuery('GMS'));
        if (!filters.company || filters.company === 'LDS') queries.push(buildQuery('LDS'));

        const unionQuery = queries.join(" UNION ALL ");
        const sortCol = sorting.sortBy === 'CreatedAt' ? 'DocEntry' : sorting.sortBy;
        
        const countResult = await request.query(`SELECT COUNT(*) AS total FROM (${unionQuery}) AS T;`);
        const dataResult = await request.query(`
            ${unionQuery} 
            ORDER BY ${sortCol} ${sorting.sortOrder === 'ASC' ? 'ASC' : 'DESC'}
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

        return {
            items: dataResult.recordset || [],
            total: countResult.recordset[0].total
        };
    }

    static async getDeliveryChallanById(docEntry, company) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('docEntry', sql.Int, docEntry);

        const dbsToTry = company === 'GMS' ? ['gms_live'] : (company === 'LDS' ? ['lds_live'] : ['gms_live', 'lds_live']);

        for (const db of dbsToTry) {
            const header = await request.query(`
                SELECT * FROM ${db}.dbo.ODLN WHERE DocEntry = @docEntry;
            `);

            if (header.recordset.length > 0) {
                const lines = await request.query(`
                    SELECT 
                        LineNum, ItemCode, Dscription, WhsCode, Quantity, Price, LineTotal 
                    FROM ${db}.dbo.DLN1 
                    WHERE DocEntry = @docEntry 
                    ORDER BY LineNum;
                `);

                const batches = await request.query(`
                    SELECT 
                        T0.BaseLinNum AS LineNum,
                        T0.BatchNum, 
                        T0.Quantity, 
                        T0.WhsCode,
                        CAST(T1.MnfDate AS DATE) AS MnfDate,
                        CAST(T1.ExpDate AS DATE) AS ExpDate
                    FROM ${db}.dbo.IBT1 T0
                    INNER JOIN ${db}.dbo.OBTN T1 ON T0.ItemCode = T1.ItemCode AND T0.BatchNum = T1.DistNumber
                    WHERE T0.BaseType = 15 AND T0.BaseEntry = @docEntry AND T0.Direction = 1;
                `);

                const serials = await request.query(`
                    SELECT S.BaseLinNum AS LineNum, S.SysSerial, O.SuppSerial, 1 AS Quantity, S.WhsCode, CAST(O.PrdDate AS DATE) AS MnfDate, CAST(O.ExpDate AS DATE) AS ExpDate
                    FROM ${db}.dbo.SRI1 S
                    LEFT JOIN ${db}.dbo.OSRI O ON S.ItemCode = O.ItemCode AND S.SysSerial = O.SysSerial
                    WHERE S.BaseType = 15 AND S.BaseEntry = @docEntry AND S.Direction = 1;
                `);

                const processedLines = (lines.recordset || []).map(line => ({
                    ...line,
                    batches: (batches.recordset || []).filter(b => b.LineNum === line.LineNum),
                    serials: (serials.recordset || []).filter(s => s.LineNum === line.LineNum)
                }));

                return {
                    header: header.recordset[0],
                    lines: processedLines,
                    company: db === 'gms_live' ? 'GMS' : 'LDS'
                };
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════
    // LOOKUPS — For CFL modals
    // ═══════════════════════════════════════════════════════════

    static async lookupVendors(company, search, pagination) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = search ? `%${search}%` : '%';
        request.input('search', sql.VarChar, searchVal);
        request.input('limit', sql.Int, pagination.limit);
        request.input('offset', sql.Int, pagination.offset);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`SELECT 'GMS' AS Company, CardCode, CardName, Phone1, City FROM gms_live.dbo.OCRD WHERE CardType = 'S' AND frozenFor = 'N' AND (CardCode LIKE @search OR CardName LIKE @search)`);
        }
        if (!company || company === 'LDS') {
            queries.push(`SELECT 'LDS' AS Company, CardCode, CardName, Phone1, City FROM lds_live.dbo.OCRD WHERE CardType = 'S' AND frozenFor = 'N' AND (CardCode LIKE @search OR CardName LIKE @search)`);
        }

        const unionQuery = queries.join(" UNION ALL ");
        const countResult = await request.query(`SELECT COUNT(*) AS total FROM (${unionQuery}) AS T;`);
        const dataResult = await request.query(`${unionQuery} ORDER BY CardName OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`);

        return {
            items: dataResult.recordset || [],
            total: countResult.recordset[0].total
        };
    }

    // ═══════════════════════════════════════════════════════════
    // INCIDENT REPORTING
    // ═══════════════════════════════════════════════════════════
    static async getIncidentReports() {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT * FROM Warehouse.dbo.IncidentReports 
            ORDER BY CreatedAt DESC;
        `);
        return result.recordset || [];
    }

    static async createIncidentReport(data) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('formDate', sql.DateTime, data.formDateTime);
        request.input('filledBy', sql.NVarChar, data.filledBy);
        request.input('filledByDesignation', sql.NVarChar, data.filledByDesignation || null);
        request.input('department', sql.NVarChar, data.department || null);
        request.input('reportTo', sql.NVarChar, data.reportTo || null);
        request.input('reportToDesignation', sql.NVarChar, data.reportToDesignation || null);
        
        request.input('incidentDate', sql.DateTime, data.incidentDateTime);
        request.input('location', sql.NVarChar, data.location);
        request.input('otherLocation', sql.NVarChar, data.otherLocation || null);
        request.input('witnessName', sql.NVarChar, data.witnessName || null);
        request.input('witnessContact', sql.NVarChar, data.witnessContact || null);
        request.input('incidentType', sql.NVarChar, data.incidentType);
        request.input('otherIncident', sql.NVarChar, data.otherIncident || null);
        request.input('description', sql.NVarChar, data.incidentDescription);
        request.input('instantActions', sql.NVarChar, data.instantActions || null);
        
        request.input('actionDate', sql.Date, data.actionDate ? new Date(data.actionDate) : null);
        request.input('externalAuthorities', sql.NVarChar, data.externalAuthorities || null);
        request.input('otherAuthorities', sql.NVarChar, data.otherAuthorities || null);
        request.input('actionsTakenByAuthority', sql.NVarChar, data.actionsTakenByAuthority || null);
        request.input('otherRelevantInfo', sql.NVarChar, data.otherRelevantInfo || null);

        const result = await request.query(`
            INSERT INTO Warehouse.dbo.IncidentReports (
                FormDate, FilledBy, FilledByDesignation, Department, ReportTo, ReportToDesignation,
                IncidentDate, Location, OtherLocation, WitnessName, WitnessContact,
                IncidentType, OtherIncident, Description, InstantActions,
                ActionDate, ExternalAuthorities, OtherAuthorities, ActionsTakenByAuthority, OtherRelevantInfo
            ) VALUES (
                @formDate, @filledBy, @filledByDesignation, @department, @reportTo, @reportToDesignation,
                @incidentDate, @location, @otherLocation, @witnessName, @witnessContact,
                @incidentType, @otherIncident, @description, @instantActions,
                @actionDate, @externalAuthorities, @otherAuthorities, @actionsTakenByAuthority, @otherRelevantInfo
            );
            SELECT SCOPE_IDENTITY() AS id;
        `);
        return { id: result.recordset[0].id };
    }

    // ═══════════════════════════════════════════════════════════
    // TRAINING CALENDAR
    // ═══════════════════════════════════════════════════════════
    static async getTrainings() {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT * FROM Warehouse.dbo.Trainings 
            ORDER BY TrainingDate DESC, StartTime DESC;
        `);
        return result.recordset || [];
    }

    static async createTraining(data) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('title', sql.NVarChar, data.title);
        request.input('department', sql.NVarChar, data.department || null);
        request.input('category', sql.NVarChar, data.category || null);
        request.input('trainerEmpId', sql.NVarChar, data.trainerEmpId || null);
        request.input('trainerName', sql.NVarChar, data.trainerName || null);
        request.input('trainingDate', sql.Date, data.trainingDate);
        request.input('startTime', sql.Time, data.startTime ? data.startTime + ':00' : null);
        request.input('duration', sql.NVarChar, data.duration || null);
        request.input('location', sql.NVarChar, data.location || null);
        request.input('status', sql.NVarChar, data.status || 'Scheduled');
        request.input('description', sql.NVarChar, data.description || null);
        request.input('attachments', sql.NVarChar, data.attachments || null);

        const result = await request.query(`
            INSERT INTO Warehouse.dbo.Trainings (
                Title, Department, Category, TrainerEmpID, TrainerName,
                TrainingDate, StartTime, Duration, Location, Status, Description, Attachments
            ) VALUES (
                @title, @department, @category, @trainerEmpId, @trainerName,
                @trainingDate, @startTime, @duration, @location, @status, @description, @attachments
            );
            SELECT SCOPE_IDENTITY() AS id;
        `);
        return { id: result.recordset[0].id };
    }

    static async getUserInfo(empId) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('empId', sql.NVarChar, empId);

        // Fetch designation and department
        const detailsResult = await request.query(`
            SELECT DesignationName, DepartmentName 
            FROM hcm_gms.dbo.MstEmployee 
            WHERE EmpId = @empId
        `);

        // Fetch report to name
        const reportToResult = await request.query(`
            SELECT FirstName as reportTo
            FROM hcm_gms.dbo.MstEmployee 
            WHERE Id = (
                SELECT reporttoid 
                FROM hcm_gms.dbo.MstEmployee 
                WHERE EmpId = @empId
            )
        `);

        const data = {};
        if (detailsResult.recordset.length > 0) {
            data.designationName = detailsResult.recordset[0].DesignationName;
            data.departmentName = detailsResult.recordset[0].DepartmentName;
        }
        if (reportToResult.recordset.length > 0) {
            data.reportTo = reportToResult.recordset[0].reportTo;
        }

        return data;
    }


    static async lookupWarehouses(company, search) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = search ? `%${search}%` : '%';
        request.input('search', sql.VarChar, searchVal);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`SELECT 'GMS' AS Company, WhsCode AS WarehouseCode, WhsName AS WarehouseName FROM gms_live.dbo.OWHS WHERE WhsCode LIKE @search OR WhsName LIKE @search`);
        }
        if (!company || company === 'LDS') {
            queries.push(`SELECT 'LDS' AS Company, WhsCode AS WarehouseCode, WhsName AS WarehouseName FROM lds_live.dbo.OWHS WHERE WhsCode LIKE @search OR WhsName LIKE @search`);
        }

        const result = await request.query(queries.join(" UNION ALL ") + " ORDER BY WarehouseName;");
        return result.recordset || [];
    }

    static async lookupAccounts(company, search) {
        const pool = await poolPromise;
        const request = pool.request();

        const searchVal = search ? `%${search}%` : '%';
        request.input('search', sql.VarChar, searchVal);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`SELECT 'GMS' AS Company, AcctCode AS AccountCode, AcctName AS AccountName FROM gms_live.dbo.OACT WHERE Postable = 'Y' AND (AcctCode LIKE @search OR AcctName LIKE @search)`);
        }
        if (!company || company === 'LDS') {
            queries.push(`SELECT 'LDS' AS Company, AcctCode AS AccountCode, AcctName AS AccountName FROM lds_live.dbo.OACT WHERE Postable = 'Y' AND (AcctCode LIKE @search OR AcctName LIKE @search)`);
        }

        const result = await request.query(queries.join(" UNION ALL ") + " ORDER BY AccountCode;");
        return result.recordset || [];
    }

    static async lookupBusinessSegments(company) {
        const pool = await poolPromise;
        const request = pool.request();
        
        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`SELECT DISTINCT U_Division AS BusinessSegment FROM gms_live.dbo.ige1 WHERE U_Division IS NOT NULL AND U_Division <> ''`);
        }
        if (!company || company === 'LDS') {
            queries.push(`SELECT DISTINCT U_Division AS BusinessSegment FROM lds_live.dbo.ige1 WHERE U_Division IS NOT NULL AND U_Division <> ''`);
        }

        const result = await request.query(queries.join(" UNION ") + " ORDER BY BusinessSegment;");
        return result.recordset || [];
    }

    static async lookupCostCenters(company) {
        const pool = await poolPromise;
        const request = pool.request();
        
        const result = await request.query(`
            SELECT BudgetCode AS CostCenterCode, Name AS CostCenterName 
            FROM dome.dbo.budgetcodes 
            ORDER BY BudgetCode;
        `);
        return result.recordset || [];
    }

    static async lookupBranches() {
        const pool = await poolPromise;
        const request = pool.request();
        
        const result = await request.query(`
            SELECT BPLId AS BranchId, BPLFrName AS BranchName 
            FROM lds_live.dbo.obpl 
            WHERE BPLFrName IS NOT NULL AND LTRIM(RTRIM(BPLFrName)) <> ''
            ORDER BY BPLFrName;
        `);
        return result.recordset || [];
    }
    static async lookupBatches(company, itemCode, whsCode) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('itemCode', sql.VarChar, itemCode);
        if (whsCode) {
            request.input('whsCode', sql.VarChar, whsCode);
        }

        let whsFilter = whsCode ? " AND T1.WhsCode = @whsCode " : "";

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    T0.DistNumber AS BatchNum,
                    T1.Quantity,
                    T1.WhsCode,
                    CAST(T0.MnfDate AS DATE) AS MnfDate,
                    CAST(T0.ExpDate AS DATE) AS ExpDate
                FROM gms_live.dbo.OBTN T0
                INNER JOIN gms_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                WHERE T0.ItemCode = @itemCode ${whsFilter} AND T1.Quantity > 0
            `);
        }
        if (!company || company === 'LDS') {
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    T0.DistNumber AS BatchNum,
                    T1.Quantity,
                    T1.WhsCode,
                    CAST(T0.MnfDate AS DATE) AS MnfDate,
                    CAST(T0.ExpDate AS DATE) AS ExpDate
                FROM lds_live.dbo.OBTN T0
                INNER JOIN lds_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                WHERE T0.ItemCode = @itemCode ${whsFilter} AND T1.Quantity > 0
            `);
        }

        const result = await request.query(queries.join(" UNION ALL ") + " ORDER BY ExpDate ASC, BatchNum ASC;");
        return result.recordset || [];
    }

    static async lookupSerials(company, itemCode, whsCode) {
        const pool = await poolPromise;
        const request = pool.request();
        
        request.input('itemCode', sql.VarChar, itemCode);
        if (whsCode) {
            request.input('whsCode', sql.VarChar, whsCode);
        }

        let whsFilter = whsCode ? " AND T1.WhsCode = @whsCode " : "";

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    T0.DistNumber AS SysSerial,
                    ISNULL(T0.MnfSerial, T0.DistNumber) AS SuppSerial,
                    1 AS Quantity,
                    T1.WhsCode,
                    CAST(T0.MnfDate AS DATE) AS MnfDate,
                    CAST(T0.ExpDate AS DATE) AS ExpDate
                FROM gms_live.dbo.OSRN T0
                INNER JOIN gms_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                WHERE T0.ItemCode = @itemCode ${whsFilter} AND T1.Quantity > 0
            `);
        }
        if (!company || company === 'LDS') {
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    T0.DistNumber AS SysSerial,
                    ISNULL(T0.MnfSerial, T0.DistNumber) AS SuppSerial,
                    1 AS Quantity,
                    T1.WhsCode,
                    CAST(T0.MnfDate AS DATE) AS MnfDate,
                    CAST(T0.ExpDate AS DATE) AS ExpDate
                FROM lds_live.dbo.OSRN T0
                INNER JOIN lds_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                WHERE T0.ItemCode = @itemCode ${whsFilter} AND T1.Quantity > 0
            `);
        }

        const result = await request.query(queries.join(" UNION ALL ") + " ORDER BY ExpDate ASC, SysSerial ASC;");
        return result.recordset || [];
    }

    static async getItemExpiryLots(itemCode, company) {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('itemCode', sql.VarChar, itemCode);

        let queries = [];
        if (!company || company === 'GMS') {
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    'Batch' AS TrackingType,
                    T0.DistNumber AS BatchNumber,
                    T1.Quantity AS StockQty,
                    T1.WhsCode,
                    ISNULL(W.WhsName, T1.WhsCode) AS WarehouseName,
                    CAST(T0.ExpDate AS DATE) AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry
                FROM gms_live.dbo.OBTN T0
                INNER JOIN gms_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                LEFT JOIN gms_live.dbo.OWHS W ON T1.WhsCode = W.WhsCode
                WHERE T0.ItemCode = @itemCode AND T1.Quantity > 0 AND T0.ExpDate IS NOT NULL
            `);
            queries.push(`
                SELECT 
                    'GMS' AS Company,
                    'Serial' AS TrackingType,
                    T0.DistNumber AS BatchNumber,
                    T1.Quantity AS StockQty,
                    T1.WhsCode,
                    ISNULL(W.WhsName, T1.WhsCode) AS WarehouseName,
                    CAST(T0.ExpDate AS DATE) AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry
                FROM gms_live.dbo.OSRN T0
                INNER JOIN gms_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                LEFT JOIN gms_live.dbo.OWHS W ON T1.WhsCode = W.WhsCode
                WHERE T0.ItemCode = @itemCode AND T1.Quantity > 0 AND T0.ExpDate IS NOT NULL
            `);
        }
        if (!company || company === 'LDS') {
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    'Batch' AS TrackingType,
                    T0.DistNumber AS BatchNumber,
                    T1.Quantity AS StockQty,
                    T1.WhsCode,
                    ISNULL(W.WhsName, T1.WhsCode) AS WarehouseName,
                    CAST(T0.ExpDate AS DATE) AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry
                FROM lds_live.dbo.OBTN T0
                INNER JOIN lds_live.dbo.OBTQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                LEFT JOIN lds_live.dbo.OWHS W ON T1.WhsCode = W.WhsCode
                WHERE T0.ItemCode = @itemCode AND T1.Quantity > 0 AND T0.ExpDate IS NOT NULL
            `);
            queries.push(`
                SELECT 
                    'LDS' AS Company,
                    'Serial' AS TrackingType,
                    T0.DistNumber AS BatchNumber,
                    T1.Quantity AS StockQty,
                    T1.WhsCode,
                    ISNULL(W.WhsName, T1.WhsCode) AS WarehouseName,
                    CAST(T0.ExpDate AS DATE) AS ExpiryDate,
                    DATEDIFF(DAY, GETDATE(), T0.ExpDate) AS DaysToExpiry
                FROM lds_live.dbo.OSRN T0
                INNER JOIN lds_live.dbo.OSRQ T1 ON T0.ItemCode = T1.ItemCode AND T0.SysNumber = T1.SysNumber
                LEFT JOIN lds_live.dbo.OWHS W ON T1.WhsCode = W.WhsCode
                WHERE T0.ItemCode = @itemCode AND T1.Quantity > 0 AND T0.ExpDate IS NOT NULL
            `);
        }

        const result = await request.query(queries.join(" UNION ALL ") + " ORDER BY ExpiryDate ASC, BatchNumber ASC;");
        return result.recordset || [];
    }
}

module.exports = InventoryModel;