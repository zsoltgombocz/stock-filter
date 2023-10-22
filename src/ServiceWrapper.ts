import moment from "moment";
import Stock, { BalanceInterface, IncomeInterface } from "./Stock";
import FinvizService, { finvizStock } from "./services/FinvizService";
import YahooService from "./services/YahooService";
import { listType, scraperStatus } from "./types";
import { client, nonStockKeys } from "./redis/client";
import { logger } from "./utils/logger";
import { BROWSER } from "./browser";
import ExcelJS from 'exceljs';

export interface ServiceWrapperInterface {
    finvizService: FinvizService;
    yahooService: YahooService;
    stocks: Stock[];
}

export default class ServiceWrapper implements ServiceWrapperInterface {
    finvizService: FinvizService;
    yahooService: YahooService;
    stocks: Stock[] = [];

    constructor(finvizService: FinvizService, yahooService: YahooService) {
        this.finvizService = finvizService;
        this.yahooService = yahooService;
    }

    getStocks = async (): Promise<Stock[]> => {
        let keys: string[] = await client.keys('*');
        let stockKeys = keys.filter(key => !nonStockKeys.includes(key));

        for (let stockKey of stockKeys) {
            const stock = await new Stock(stockKey).load();

            this.stocks.push(stock);
        }

        return this.stocks;
    }

    saveFinvizStocks = async () => {
        const lastUpdate = await this.finvizService.getLastUpdate();
        const diff = moment.unix(lastUpdate / 1000 || 0).add(1, 'days').diff(moment.now(), 'hours');

        if ((diff < 1 || lastUpdate === 0) ||
            (diff > 1 && this.finvizService.getStatus() !== scraperStatus.FINISHED)
        ) {
            const scrapedStocks: finvizStock[] = await this.finvizService.getFinvizData();
            for (let i = 0; i < scrapedStocks.length; i++) {
                await new Stock(
                    scrapedStocks[i].name,
                    scrapedStocks[i].country,
                    scrapedStocks[i].sector
                ).save();
            }
        }
    }

    updateStocks = async () => {
        const lastUpdate = await this.finvizService.getLastUpdate();
        const diff = moment.unix(lastUpdate / 1000 || 0).add(1, 'days').diff(moment.now(), 'hours');

        if ((diff < 1 || lastUpdate === 0) ||
            (diff > 1 && this.yahooService.getStatus() !== scraperStatus.FINISHED)
        ) {
            const allKeys = await client.keys('*');
            if (allKeys === null) return;

            const stocks = allKeys.filter(key => !nonStockKeys.includes(key));

            for (let stockKey of stocks) {
                const stock = await new Stock(stockKey).load();
                const financialData = await this.yahooService.getFinancialData(stockKey);

                if (financialData === null) {
                    logger.info(`[SERVICE-WRAPPER]: Got null as financial data for ${stockKey}`);
                    continue;
                }

                stock.setFinancials(financialData);
                stock.updateEligibility();
                stock.updateIncomePercentage();
                stock.sortStock();
                await stock.save();
            }

            BROWSER?.close();
        }
    }

    generateExcel = async (): Promise<void> => {
        try {
            const workbook = new ExcelJS.Workbook();

            const stocks = await this.getStocks();

            const okStocks = stocks.filter(stock => stock.list.includes(listType.ANNUAL_OK_QUARTERLY_OK));

            const tab1 = stocks.filter(stock => stock.list.includes(listType.ANNUAL_OK));
            const tab2 = okStocks;
            const tab3 = stocks.filter(stock => stock.list.includes(listType.ANNUAL_OK_QUARTERLY_NO));
            const tab4 = stocks.filter(stock => stock.list.includes(listType.QUARTERLY_OK));
            const tab5 = stocks.filter(stock => stock.list.includes(listType.QUARTERLY_NO));

            const tabs = [
                { name: listType.ANNUAL_OK, data: tab1 },
                { name: listType.ANNUAL_OK_QUARTERLY_OK, data: tab2 },
                { name: listType.ANNUAL_OK_QUARTERLY_NO, data: tab3 },
                { name: listType.QUARTERLY_OK, data: tab4 },
                { name: listType.QUARTERLY_NO, data: tab5 }
            ];

            tabs.forEach(tab => {
                const worksheet = workbook.addWorksheet(tab.name);

                tab.data.forEach((stock: Stock) => {
                    worksheet.addRow([stock.name]);
                });
            });

            const percentWorksheet = workbook.addWorksheet('%');
            percentWorksheet.addRow([
                'Név', 'Szektor', 'Össz %', '1. %', '2. %', '3. %', '4. %', '5. %', 'Market Cap', 'Total assets/Total Liabilities'
            ]);

            okStocks.forEach(stock => {
                const lastYearIncome: BalanceInterface | undefined =
                    stock.financials?.balance?.annual?.[stock?.financials?.balance?.annual?.length - 1];
                const lastYearAssets = lastYearIncome?.totalAssets || 0;
                const lastYearLiabilities = lastYearIncome?.totalLiabilities || 0

                percentWorksheet.addRow([
                    stock.name,
                    stock?.sector,
                    stock.computed?.income?.avgPercentage,
                    ...stock.computed?.income?.annualPercentages || [],
                    stock.financials?.marketCap,
                    lastYearLiabilities === 0 ? null : lastYearAssets / lastYearLiabilities
                ]);
            });

            const percentOKWorksheet = workbook.addWorksheet('% OK');
            percentOKWorksheet.addRow([
                'Név', 'Szektor', 'Össz %', '1. %', '2. %', '3. %', '4. %', '5. %', 'Market Cap', 'Total assets/Total Liabilities'
            ]);

            okStocks
                .filter(stock => stock.hasFourAnnualBalance() && stock.hasFourQuarterlyBalance)
                .forEach(stock => {
                    const lastYearIncome: BalanceInterface | undefined =
                        stock.financials?.balance?.annual?.[stock?.financials?.balance?.annual?.length - 1];
                    const lastYearAssets = lastYearIncome?.totalAssets || 0;
                    const lastYearLiabilities = lastYearIncome?.totalLiabilities || 0

                    percentOKWorksheet.addRow([
                        stock.name,
                        stock?.sector,
                        stock.computed?.income?.avgPercentage,
                        ...stock.computed?.income?.annualPercentages || [],
                        stock.financials?.marketCap,
                        lastYearLiabilities === 0 ? null : lastYearAssets / lastYearLiabilities
                    ]);
                });

            const year = new Date().getFullYear();
            const month = new Date().getMonth() + 1;

            workbook.xlsx
                .writeFile(`./public/${year}-${month < 10 ? '0' + month : month}.xlsx`);

            logger.info(`[SERVICE-WRAPPER]: Excel created!`);
        } catch (error) {
            logger.error(`[SERVICE-WRAPPER]: Error while creating excel: ${error}`);
        }
    }
}