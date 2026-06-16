const fs = require('fs');
const csv = require('csv-parser');

console.log('Validando tads_mobile.csv...\n');

const questoes = [];
fs.createReadStream('tads_mobile.csv')
    .pipe(csv())
    .on('data', (row) => questoes.push(row))
    .on('end', () => {
        console.log(`Total de questões: ${questoes.length}\n`);
        
        questoes.forEach((q, i) => {
            const tipo = q['tipo-questao'] || q['tipo_questao'] || q.tipo || '(vazio)';
            const tipoTrim = tipo.trim();
            const tipoLower = tipoTrim.toLowerCase();
            
            console.log(`${i + 1}. "${q.titulo}"`);
            console.log(`   Tipo bruto: "${tipo}"`);
            console.log(`   Tipo trimmed: "${tipoTrim}"`);
            console.log(`   Tipo lowercase: "${tipoLower}"`);
            console.log(`   Comprimento: ${tipo.length}`);
            console.log(`   Bytes: ${Buffer.from(tipo).toString('hex')}`);
            console.log('');
        });
    });
