require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const readline = require('readline');

// Função auxiliar para aguardar confirmação do usuário no terminal
async function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function run() {
    const questoes = [];
    
    // Define o arquivo CSV que será lido
    const arquivoCSV = 'questoes.csv';
    const nomeQuestionarioBase = path.basename(arquivoCSV, path.extname(arquivoCSV)); // Extrai "questoes"
    
    // 1. Ler o arquivo CSV
    console.log(`Lendo arquivo ${arquivoCSV}...`);
    try {
        await new Promise((resolve, reject) => {
            fs.createReadStream(arquivoCSV)
                .pipe(csv({ separator: ';' }))
                .on('data', (data) => questoes.push(data))
                .on('end', () => resolve())
                .on('error', reject);
        });
        console.log(`Foram carregadas ${questoes.length} questões do CSV.`);
    } catch (e) {
        console.error("Erro ao ler o arquivo CSV. Verifique se ele existe e tem o formato correto.");
        return;
    }

    if (questoes.length === 0) {
        console.log("Nenhuma questão encontrada no CSV. Finalizando...");
        return;
    }

    // 2. Iniciar o Playwright com persistência de sessão
    console.log('Iniciando o navegador...');
    
    // Launch persistent context para salvar cookies/login
    const browserContext = await chromium.launchPersistentContext('./user_data_pw', {
        headless: false,
        args: ['--start-maximized'],
        noViewport: true // Abre maximizado sem limite de tamanho de janela
    });

    // Pega a página inicial que foi aberta automaticamente pelo contexto
    const page = browserContext.pages()[0];
    
    await page.goto('https://presencial.ifms.edu.br/login/index.php');

    // Tenta fazer o login automático se os campos estiverem na tela (às vezes a sessão não salva por configuração do servidor)
    try {
        await page.waitForTimeout(2000); // Aguarda a página carregar
        const usernameInput = await page.getByRole('textbox', { name: 'Identificação de usuário' });
        if (await usernameInput.isVisible()) {
            console.log("Realizando login automaticamente...");
            await usernameInput.fill(process.env.MOODLE_USER);
            await page.getByRole('textbox', { name: 'Senha' }).fill(process.env.MOODLE_PASS);
            await page.getByRole('button', { name: 'Acessar' }).click();
            console.log("Login realizado!");
        }
    } catch (e) {
        console.log("Aviso: Falha ao tentar login automático, ou já está logado.");
    }

    console.log("==================================================================");
    console.log("1. Vá para o curso desejado.");
    console.log("2. Ative o 'Modo de Edição' no botão lá em cima.");
    console.log("3. Vá até o Bloco/Seção desejada e CLIQUE EM 'Adicionar uma atividade ou recurso'.");
    console.log("4. Espere o menu (modal) de adicionar atividade aparecer na tela.");
    console.log("==================================================================");
    await askQuestion("Pressione ENTER aqui no terminal apenas QUANDO A JANELA DE ESCOLHER ATIVIDADES ESTIVER ABERTA...");

    try {
        // Agora rodamos os passos do Playwright usando o menu que o usuário já abriu
        console.log("Criando o questionário...");

        // Seleciona a opção Questionário no menu que está aberto
        await page.getByRole('link', { name: 'Questionário', exact: true }).click();
        
        // Preenche o nome do questionário
        const dataAtual = new Date().toLocaleString('pt-BR');
        await page.getByRole('textbox', { name: 'Nome' }).fill(`${nomeQuestionarioBase} - ${dataAtual}`);
        
        // Salva e acessa a página do questionário
        await page.getByRole('button', { name: 'Salvar e mostrar' }).click();
        
        // Clica para adicionar a primeira questão (entrar no painel de edição do questionário)
        await page.getByRole('link', { name: 'Adicionar questão' }).click();

        // 4. Loop para inserir as questões do CSV
        console.log("Iniciando a inserção das questões...");
        
        for (let i = 0; i < questoes.length; i++) {
            const q = questoes[i];
            console.log(`[${i+1}/${questoes.length}] Inserindo: ${q.titulo}...`);

            // Fluxo capturado pelo codegen para criar uma nova questão
            // Utilizamos o .last() porque a cada nova questão inserida, o Moodle cria 
            // múltiplos menus "Adicionar" na página, e queremos adicionar ao final.
            await page.getByRole('button', { name: 'Adicionar' }).last().click();
            await page.getByRole('menuitem', { name: 'uma nova questão uma nova' }).last().click();
            
            // Define o tipo da questão (Padrão: Múltipla escolha)
            const campoTipo = q['tipo-questao'] || q.tipo;
            const tipoQuestao = campoTipo ? campoTipo.trim().toLowerCase() : 'múltipla escolha';

            // Escolhe o radio correspondente ao tipo de questão da coluna do CSV
            if (tipoQuestao.includes('verdadeiro') || tipoQuestao.includes('falso')) {
                await page.getByRole('radio', { name: 'Verdadeiro/Falso' }).check();
            } else if (tipoQuestao.includes('curta')) {
                await page.locator('#item_qtype_shortanswer').check();
            } else if (tipoQuestao.includes('dissertação') || tipoQuestao.includes('ensaio')) {
                await page.getByRole('radio', { name: 'Dissertação' }).check();
            } else if (tipoQuestao.includes('associação')) {
                await page.locator('#item_qtype_match').check();
            } else {
                // Padrão
                await page.locator('#item_qtype_multichoice').check();
            }
            
            await page.getByRole('button', { name: 'Adicionar' }).click();

            // Título
            await page.getByRole('textbox', { name: 'Nome da questão' }).fill(q.titulo);

            // Enunciado (Lidar com o iframe TinyMCE perfeitamente via Playwright)
            // No Playwright, `contentFrame().locator('body')` nos permite escrever dentro de editores wysiwyg com facilidade!
            await page.locator('#id_questiontext_ifr').contentFrame().locator('body').fill(q.enunciado);

            // Processar alternativas e respostas de acordo com o tipo
            if (tipoQuestao === 'múltipla escolha' || tipoQuestao === '') {
                const alternatives = [q.alt_a, q.alt_b, q.alt_c, q.alt_d, q.alt_e];
                const letterToIndex = { 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4 };
                const correctIndex = letterToIndex[q.correta ? q.correta.toLowerCase().trim() : 'a'];

                for (let altIdx = 0; altIdx < alternatives.length; altIdx++) {
                    if (!alternatives[altIdx]) continue; // Pula vazias

                    // Preenche o campo da alternativa (iframe)
                    await page.locator(`#id_answer_${altIdx}_ifr`).contentFrame().locator('body').fill(alternatives[altIdx]);

                    // Define a nota para 100% (1.0) se for a correta
                    if (altIdx === correctIndex) {
                        await page.locator(`#id_fraction_${altIdx}`).selectOption('1.0');
                    }
                }
            } else if (tipoQuestao.includes('verdadeiro') || tipoQuestao.includes('falso')) {
                if (q.correta) {
                    const corretaFormatada = q.correta.trim().toLowerCase();
                    if (corretaFormatada === 'verdadeiro' || corretaFormatada === 'v') {
                        // No HTML do Moodle, value="1" é Verdadeiro e value="0" é Falso
                        await page.locator('#id_correctanswer').selectOption('1'); 
                    } else if (corretaFormatada === 'falso' || corretaFormatada === 'f') {
                        await page.locator('#id_correctanswer').selectOption('0'); 
                    }
                }
            } else if (tipoQuestao.includes('associação')) {
                const alternatives = [q.alt_a, q.alt_b, q.alt_c, q.alt_d, q.alt_e];
                let subIdx = 0;
                
                for (const alt of alternatives) {
                    if (!alt) continue;
                    
                    // Assumimos o formato "Pergunta=Resposta" no CSV (ex: "Cachorro=Latido")
                    const partes = alt.split('=');
                    if (partes.length >= 2) {
                        const subPergunta = partes[0].trim();
                        // Junta o resto caso a resposta tenha o caractere "=" no meio
                        const subResposta = partes.slice(1).join('=').trim();
                        
                        // O Moodle cria 3 campos por padrão (0, 1 e 2)
                        if (subIdx <= 2) {
                            await page.locator(`#id_subquestions_${subIdx}_ifr`).contentFrame().locator('body').fill(subPergunta);
                            await page.locator(`#id_subanswers_${subIdx}`).fill(subResposta);
                            subIdx++;
                        }
                    }
                }
            } else if (tipoQuestao.includes('curta')) {
                // Para resposta curta, qualquer texto nas alternativas ou na coluna correta será considerado uma resposta 100% aceita.
                const acceptedAnswers = [q.correta, q.alt_a, q.alt_b, q.alt_c, q.alt_d, q.alt_e]
                    .map(a => a ? a.trim() : '')
                    .filter(a => a !== '');
                
                // Remove duplicatas
                const uniqueAnswers = [...new Set(acceptedAnswers)];
                
                for (let i = 0; i < uniqueAnswers.length; i++) {
                    if (i <= 2) { // Moodle cria 3 campos por padrão para respostas curtas
                        await page.locator(`#id_answer_${i}`).fill(uniqueAnswers[i]);
                        await page.locator(`#id_fraction_${i}`).selectOption('1.0'); // 1.0 representa 100% da nota
                    }
                }
            }

            // Salva a questão e retorna para a lista
            await page.getByRole('button', { name: 'Salvar mudanças', exact: true }).click();

            // Espera a página de lista de questões carregar (garante que voltamos pra tela certa)
            // Esperamos o botão 'Adicionar' ficar visível novamente
            await page.getByRole('button', { name: 'Adicionar' }).first().waitFor({ state: 'visible', timeout: 30000 });
            
            console.log(`Questão "${q.titulo}" salva com sucesso!`);
            
            // Aguarda 3 segundos para que o Moodle termine qualquer requisição AJAX (recarregamento da lista)
            // antes de tentar clicar em "Adicionar" novamente.
            await page.waitForTimeout(3000);
        }

        console.log("==================================================================");
        console.log("Todas as questões foram inseridas com sucesso no questionário!");
        console.log("==================================================================");

    } catch (e) {
        console.error("Ocorreu um erro durante a automação Playwright:", e.message);
    }

    await askQuestion("Pressione ENTER para fechar o navegador e encerrar o script...");
    await browserContext.close();
}

run().catch(console.error);
