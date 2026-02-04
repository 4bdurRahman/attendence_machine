// Quick test to see if date parsing works correctly
const sampleRecord = {
    record_time: 'Mon Jun 02 2025 08:58:04 GMT+0500 (Pakistan Standard Time)'
};

console.log('Testing date parsing:');
console.log('Original:', sampleRecord.record_time);

const date = new Date(sampleRecord.record_time);
console.log('Parsed Date:', date);
console.log('ISO String:', date.toISOString());
console.log('Year:', date.getFullYear());
console.log('Month:', date.getMonth(), '(0-indexed, so June = 5)');
console.log('Date:', date.getDate());
console.log('');

// Test filter values
const testFilters = [
    { type: 'date', value: '2025-06-02' },
    { type: 'month', value: '2025-06' },
    { type: 'year', value: '2025' }
];

testFilters.forEach(filter => {
    console.log(`\nTesting ${filter.type} filter with value: ${filter.value}`);

    if (filter.type === 'date') {
        const targetDate = new Date(filter.value + 'T00:00:00');
        console.log('  Target Date:', targetDate);
        console.log('  Target Y:', targetDate.getFullYear(), 'M:', targetDate.getMonth(), 'D:', targetDate.getDate());
        console.log('  Log Y:', date.getFullYear(), 'M:', date.getMonth(), 'D:', date.getDate());

        const match = date.getFullYear() === targetDate.getFullYear() &&
            date.getMonth() === targetDate.getMonth() &&
            date.getDate() === targetDate.getDate();
        console.log('  MATCH:', match);
    } else if (filter.type === 'month') {
        const [year, month] = filter.value.split('-');
        const match = date.getFullYear() === parseInt(year) &&
            (date.getMonth() + 1) === parseInt(month);
        console.log('  Target: Y=' + year + ' M=' + month);
        console.log('  Log: Y=' + date.getFullYear() + ' M=' + (date.getMonth() + 1));
        console.log('  MATCH:', match);
    } else if (filter.type === 'year') {
        const match = date.getFullYear() === parseInt(filter.value);
        console.log('  Target Year:', filter.value);
        console.log('  Log Year:', date.getFullYear());
        console.log('  MATCH:', match);
    }
});
