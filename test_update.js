require('dotenv').config();
const ComplaintsModel = require('./src/controller/Complaints/complaints.model.js');

async function run() {
    try {
        const result = await ComplaintsModel.updateComplaint('AC-001', {
            Product: 'AC000001',
            BriefDescription: 'Test from script'
        }, 'Script');
        console.log("Success:", result);
    } catch (err) {
        console.error("Error:", err);
    }
    process.exit(0);
}

run();
