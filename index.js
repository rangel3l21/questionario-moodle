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

function getCsvValue(row, names) {
    for (const name of names) {
        if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') {
            return String(row[name]).trim();
        }
    }

    return '';
}

function normalizeFormat(format) {
    return (format || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[|,;]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function decodeCsvText(value) {
    return String(value || '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function isTrueFalseType(type) {
    const normalized = normalizeText(type);
    return normalized.includes('verdadeiro') || normalized.includes('falso');
}

function isShortAnswerType(type) {
    return normalizeText(type).includes('curta');
}

function isAssociationType(type) {
    const normalized = normalizeText(type);
    return normalized.includes('associacao') || normalized.includes('assoc');
}

function isEssayType(type) {
    const normalized = normalizeText(type);
    return normalized.includes('dissertacao') || normalized.includes('ensaio');
}

function isMultipleChoiceType(type) {
    return !type || (!isTrueFalseType(type) && !isShortAnswerType(type) && !isAssociationType(type) && !isEssayType(type));
}

function getQuestionTextType(row) {
    return getCsvValue(row, [
        'tipo_texto_questao',
        'tipo-texto-questao',
        'tipo_texto',
        'tipo-texto',
        'formatacao_enunciado',
        'formatacao-enunciado',
        'formato_enunciado',
        'formato-enunciado'
    ]);
}

function getAlternativeTextType(row, index) {
    const letter = String.fromCharCode(97 + index);
    return getCsvValue(row, [
        `tipo_texto_alt_${letter}`,
        `tipo-texto-alt-${letter}`,
        `formatacao_alt_${letter}`,
        `formatacao-alt-${letter}`,
        `formato_alt_${letter}`,
        `formato-alt-${letter}`
    ]);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatJsonLike(value) {
    const text = decodeCsvText(value).trim();
    if (!text) return text;

    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
        try {
            const jsonCandidate = text
                .replace(/'/g, '"')
                .replace(/,\s*([}\]])/g, '$1');
            return JSON.stringify(JSON.parse(jsonCandidate), null, 2);
        } catch (ignored) {
            return text;
        }
    }
}

function looksLikeCodeBlock(text) {
    const value = decodeCsvText(text).trim();
    return (
        /^(\{|\[)[\s\S]*(\}|\])$/.test(value) ||
        /[\r\n]\s*(\{|\[|'[^']+'\s*:|"[^"]+"\s*:)/.test(value) ||
        /\b(const|let|var|function|class|if|for|while|return)\b[\s\S]*[;{}]/.test(value)
    );
}

function textToHtml(text) {
    return decodeCsvText(text)
        .split(/\r?\n/)
        .map(line => line.trim() === '' ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`)
        .join('');
}

function getCodeBlockHtml(code) {
    return [
        '<pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;',
        'padding:12px;white-space:pre-wrap;font-family:Consolas,Monaco,monospace;',
        'font-size:14px;line-height:1.45;overflow-x:auto;text-align:left;"><code>',
        escapeHtml(formatJsonLike(code)),
        '</code></pre>'
    ].join('');
}

function getInlineCodeHtml(code) {
    return [
        '<code style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;',
        'padding:2px 5px;font-family:Consolas,Monaco,monospace;',
        'font-size:0.95em;white-space:nowrap;">',
        escapeHtml(decodeCsvText(code)),
        '</code>'
    ].join('');
}

function structuredTextToHtml(text) {
    const value = decodeCsvText(text);
    const firstCurly = value.indexOf('{');
    const firstSquare = value.indexOf('[');
    const starts = [firstCurly, firstSquare].filter(index => index >= 0);

    if (starts.length === 0) {
        return getCodeBlockHtml(value);
    }

    const codeStart = Math.min(...starts);
    const codeEnd = Math.max(value.lastIndexOf('}'), value.lastIndexOf(']'));

    if (codeEnd < codeStart) {
        return getCodeBlockHtml(value);
    }

    const before = value.slice(0, codeStart).trim();
    const code = value.slice(codeStart, codeEnd + 1);
    const after = value.slice(codeEnd + 1).trim();
    const html = [];

    if (before) html.push(textToHtml(before));
    html.push(getCodeBlockHtml(code));
    if (after) html.push(textToHtml(after));

    return html.join('');
}

function textWithCodeBlocksToHtml(text, type = '') {
    const normalizedType = normalizeText(type);
    const forceStructuredText = (
        normalizedType.includes('json') ||
        normalizedType.includes('vetor') ||
        normalizedType.includes('array') ||
        normalizedType.includes('codigo') ||
        normalizedType.includes('code')
    );

    if (forceStructuredText) {
        return structuredTextToHtml(text);
    }

    const lines = decodeCsvText(text).split(/\r?\n/);
    const html = [];
    let codeLines = [];

    const flushCode = () => {
        if (codeLines.length === 0) return;
        html.push(getCodeBlockHtml(codeLines.join('\n')));
        codeLines = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const isCodeLine = (
            trimmed.startsWith('{') ||
            trimmed.startsWith('}') ||
            trimmed.startsWith('[') ||
            trimmed.startsWith(']') ||
            /^['"][^'"]+['"]\s*:/.test(trimmed) ||
            /^[A-Za-z_$][\w$]*\s*[:=]/.test(trimmed) ||
            /[,;]$/.test(trimmed) ||
            (forceStructuredText && looksLikeCodeBlock(trimmed))
        );

        if (isCodeLine) {
            codeLines.push(line);
            continue;
        }

        flushCode();
        html.push(trimmed === '' ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`);
    }

    flushCode();
    return html.join('');
}

async function clickTinyToolbarButton(page, buttonName) {
    const button = page.locator(`button[data-mce-name="${buttonName}"][aria-disabled="false"]`).last();

    if (await button.count() === 0) {
        console.log(`Aviso: botao TinyMCE "${buttonName}" nao encontrado.`);
        return false;
    }

    try {
        await button.click({ timeout: 2000 });
        return true;
    } catch (e) {
        const overflowButton = page.locator('button[data-mce-name="overflow-button"][aria-expanded="false"]').last();
        if (await overflowButton.count() > 0) {
            await overflowButton.click({ timeout: 2000 });
            await page.locator(`button[data-mce-name="${buttonName}"][aria-disabled="false"]`).last().click({ timeout: 3000 });
            return true;
        }

        console.log(`Aviso: nao foi possivel clicar no botao TinyMCE "${buttonName}".`);
        return false;
    }
}

async function setTinyMceHtml(page, iframeSelector, html) {
    const frame = page.locator(iframeSelector).contentFrame();
    await frame.locator('body').click();
    await page.evaluate(({ selector, content }) => {
        const iframe = document.querySelector(selector);
        const editor = iframe && window.tinymce && window.tinymce.get(iframe.id.replace(/_ifr$/, ''));

        if (editor) {
            editor.setContent(content);
            editor.fire('change');
            editor.save();
            return;
        }

        if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
            iframe.contentDocument.body.innerHTML = content;
            iframe.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }, { selector: iframeSelector, content: html });
}

async function fillTinyMceFormatted(page, iframeSelector, text, format) {
    const value = decodeCsvText(text);
    const formats = normalizeFormat(format);
    const frame = page.locator(iframeSelector).contentFrame();
    const body = frame.locator('body');

    await body.click();
    await body.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await body.press('Backspace');

    const isJsonLike = formats.includes('json') || formats.includes('vetor') || formats.includes('array');
    const isInlineCode = (formats.includes('codigo') || formats.includes('code')) && !isJsonLike && !/[\r\n]/.test(value);
    const isCode = isInlineCode || isJsonLike || looksLikeCodeBlock(value);
    const isBulletList = formats.includes('lista') || formats.includes('topicos') || formats.includes('marcadores') || formats.includes('bullist');
    const isNumberedList = formats.includes('numerada') || formats.includes('ordenada') || formats.includes('numlist');
    const isBold = formats.includes('negrito') || formats.includes('bold');
    const isItalic = formats.includes('italico') || formats.includes('italic');

    if (formats.includes('esquerda') || formats.includes('alignleft')) {
        await clickTinyToolbarButton(page, 'alignleft');
    } else if (formats.includes('centro') || formats.includes('centralizado') || formats.includes('aligncenter')) {
        await clickTinyToolbarButton(page, 'aligncenter');
    } else if (formats.includes('direita') || formats.includes('alignright')) {
        await clickTinyToolbarButton(page, 'alignright');
    }

    if (isInlineCode) {
        await setTinyMceHtml(page, iframeSelector, getInlineCodeHtml(value));
        return;
    }

    if (isCode) {
        await setTinyMceHtml(page, iframeSelector, textWithCodeBlocksToHtml(value, format));
        return;
    }

    if (isBold) await clickTinyToolbarButton(page, 'bold');
    if (isItalic) await clickTinyToolbarButton(page, 'italic');

    if (isNumberedList || isBulletList) {
        await clickTinyToolbarButton(page, isNumberedList ? 'numlist' : 'bullist');
        const lines = value.split(/\r?\n/).map(line => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''));
        await body.type(lines.join('\n'), { delay: 5 });
    } else {
        await body.type(value, { delay: 5 });
    }

    if (isItalic) await clickTinyToolbarButton(page, 'italic');
    if (isBold) await clickTinyToolbarButton(page, 'bold');
}

async function run() {
    const questoes = [];
    
    // Define o arquivo CSV que será lido
    const arquivoCSV = 'lidar_vetor_de_objetos.csv';
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
            if (isTrueFalseType(tipoQuestao)) {
                await page.getByRole('radio', { name: 'Verdadeiro/Falso' }).check();
            } else if (isShortAnswerType(tipoQuestao)) {
                await page.locator('#item_qtype_shortanswer').check();
            } else if (tipoQuestao.includes('dissertação') || tipoQuestao.includes('ensaio')) {
                await page.getByRole('radio', { name: 'Dissertação' }).check();
            } else if (isAssociationType(tipoQuestao)) {
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
            await fillTinyMceFormatted(
                page,
                '#id_questiontext_ifr',
                q.enunciado,
                getQuestionTextType(q)
            );

            // Processar alternativas e respostas de acordo com o tipo
            if (isMultipleChoiceType(tipoQuestao)) {
                const alternatives = [q.alt_a, q.alt_b, q.alt_c, q.alt_d, q.alt_e];
                const letterToIndex = { 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4 };
                const correctIndex = letterToIndex[q.correta ? q.correta.toLowerCase().trim() : 'a'];

                for (let altIdx = 0; altIdx < alternatives.length; altIdx++) {
                    if (!alternatives[altIdx]) continue; // Pula vazias

                    // Preenche o campo da alternativa (iframe)
                    await fillTinyMceFormatted(
                        page,
                        `#id_answer_${altIdx}_ifr`,
                        alternatives[altIdx],
                        getAlternativeTextType(q, altIdx)
                    );

                    // Define a nota para 100% (1.0) se for a correta
                    if (altIdx === correctIndex) {
                        await page.locator(`#id_fraction_${altIdx}`).selectOption('1.0');
                    }
                }
            } else if (isTrueFalseType(tipoQuestao)) {
                if (q.correta) {
                    const corretaFormatada = q.correta.trim().toLowerCase();
                    if (corretaFormatada === 'verdadeiro' || corretaFormatada === 'v') {
                        // No HTML do Moodle, value="1" é Verdadeiro e value="0" é Falso
                        await page.locator('#id_correctanswer').selectOption('1'); 
                    } else if (corretaFormatada === 'falso' || corretaFormatada === 'f') {
                        await page.locator('#id_correctanswer').selectOption('0'); 
                    }
                }
            } else if (isAssociationType(tipoQuestao)) {
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
                            await fillTinyMceFormatted(page, `#id_subquestions_${subIdx}_ifr`, subPergunta, '');
                            await page.locator(`#id_subanswers_${subIdx}`).fill(subResposta);
                            subIdx++;
                        }
                    }
                }
            } else if (isShortAnswerType(tipoQuestao)) {
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
