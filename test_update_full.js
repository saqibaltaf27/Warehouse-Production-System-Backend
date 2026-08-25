require('dotenv').config();
const ComplaintsModel = require('./src/controller/Complaints/complaints.model.js');

async function run() {
    try {
        const getAll = await ComplaintsModel.getAllComplaints({limit: 10, offset: 0});
        const comp = getAll.data.find(c => c.complaintNumber === 'AC-001');
        
        if (!comp) { console.log("Not found"); return; }
        
        const payload = {
            Product: comp.product,
            ProductCategory: comp.productCategory,
            ReportDate: comp.reportDate,
            Department: comp.department,
            ComplaintBy: comp.complaintBy,
            Address: comp.address,
            Contacts: comp.contacts,
            InitiatedBy: comp.initiatedBy,
            DeviationCategory: comp.deviationCategory,
            BriefDescription: comp.briefDescription + " Edited!",
            BatchNumber: comp.batchNumber,
            RootCauseClass: comp.rootCauseClass,
            IdentifiedRootCause: comp.identifiedRootCause,
            ConcernedDepartment: comp.concernedDepartment,
            Stage1: comp.stage1,
            Stage2: comp.stage2,
            Stage3: comp.stage3,
            Stage4: comp.stage4,
            AdditionalRemarks: comp.additionalRemarks,
            CAPASummary: comp.capaSummary,
            ClosingDate: comp.closingDate,
            CumulativeFrequency: comp.cumulativeFrequency
        };

        const result = await ComplaintsModel.updateComplaint('AC-001', payload, 'Script');
        console.log("Success:", result);
    } catch (err) {
        console.error("Error:", err);
    }
    process.exit(0);
}

run();
