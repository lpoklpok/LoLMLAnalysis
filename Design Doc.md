# Design Doc for LoL Analysis

## 1. Goal

- The goal of this project is to grab historical data, grab historical odds data, clean the data and create visualizations on past performance. Then I would like to run so ML methods on the data, with some feature engineering, to make the best possible pre-game predictions model (by reducing the average log loss of the test population of individual games). The idea is that once I have a strong baseline for pre-game fair values, I can test some theories i have which include 1. Favorites win their first game more than implied assuming independence across games in a series. 2. Draft is complex and often forwards looking which is undermodelled in systematic models. 

## 2. Plan
 - A. Ingest historical match data from OraclesElixir
 - B. Ingest historical odds data from OddsPortal
 - C. Clean the data, add new features (feature engineer)
 - D. Run cross validation (this would require using train data of older games vs testing newer games) and ML techniques (logistic regression, RF, XG, NN) 
 - E. Minimize log-loss
 - F. Visualize outcomes and backtest strategies
 - G. Make predictions for upcoming games
 
 ## 3. Considerations and Limitations of the Plan
 - The data ingested is all from free sources, this means for OraclesElixir this isnt the most commprehensive data (as many leagues are missing key information) and OddsPortal require a manual web scrape (which takes time and isnt comprehensive - aka doesn't log 10% of major league games and doesn't log any amateur games even though we are using those as training and test data'- but its free, other data sources require money but could be considered if the trade-off between time/consistent data is worth the money)
 - We need to create a system that combines the datasets together cleanly since they come from different sources and likely use slightly different names for some teams
 - With limited data we also likely miss out on potential features we can add
 - We are missing potentially other sources of information including, but not limited to, patch history, high elo ranked stats, scrim results (although this would be insider info).
 - Even the best models will not be able to predict the winner with 100% accuracy since upsets are common 
 - Data is extremely limited and sophisticated ML techniques may not work and cause overfitting 
 
 ## 4. Infrastructure
 - A. Put strict documentation of all steps in GitHub repo
 - B. Store data in some cloud database (maybe AWS)
 - C. Create a website that pulls consolidated data and can create visuals 
 - D. Have an automated system that refreshes data and refits the model after a period of time
 
## 5. Feature List (draft)
Here are a list of things to think about adding in the first run of the model
- Hot streak (W/L of past 3 games)
- Player ELO (baseline skill of each player playing, it will combine into a team elo that updates automatically after each game, this allows for players to carry over elo when they switch teams)
- Matchup win rate (this accounts for good/bad matchups between teams)
- Playoff Indicator (this should not be its own factor with a beta rather it should be a multiplier on top of the overall win rate so that win rates can be adjusted based on favorites testing things during games that don't matter for seeding/making playoffs)

## 6. Evaluation
- We will be comparing baseline/coin flip vs. market vs. our model log loss
- We will be using a .5 kelly criterion on our test case with max drawdown of 30% and determine the ROI over this time frame, we will assume that it is possible to get the size required by paying 2% slippage through the implied market odds at close and start off with $10,000. Success will be returning profit that is within 2 SD from the expected profit. 
